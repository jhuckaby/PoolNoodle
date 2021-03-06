// PoolNoodle Server Component
// Copyright (c) 2018 Joseph Huckaby
// Released under the MIT License

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var Path = require('path');

var ACL = require('pixl-acl');
var Config = require("pixl-config");
var Class = require("pixl-class");
var Component = require("pixl-server/component");
var Tools = require("pixl-tools");

var async = Tools.async;
var glob = Tools.glob;
var mkdirp = Tools.mkdirp;

module.exports = Class.create({
	
	__name: 'PoolNoodle',
	__parent: Component,
	__version: require('../package.json').version,
	
	web: null,
	pm: null,
	apps: null,
	routes: null,
	plugins: null,
	stats: null,
	watchers: null,
	watchTimer: null,
	
	startup: function(callback) {
		// start app api service
		var self = this;
		this.logDebug(3, "PoolNoodle engine v" + this.__version + " starting up" );
		
		// we'll need these components frequently
		this.web = this.server.WebServer;
		this.pm = this.server.PoolManager;
		
		// optionally handle special internal stats URI
		if (this.config.get('stats_uri_match')) {
			this.web.addURIHandler( 
				new RegExp(this.config.get('stats_uri_match')), 
				'PoolNoodle Stats', 
				true, // ACL lock for this API
				this.handle_stats.bind(this) 
			);
		}
		
		// catch all requests
		this.web.addURIHandler( /.+/, 'PoolNoodle', this.handle_request.bind(this) );
		
		// reloader queue (single thread)
		this.reloadQueue = async.queue( this.reloadApps.bind(this), 1 );
		
		// reload on main config reload
		this.server.config.on('reload', function() {
			self.reloadQueue.push( {} );
		});
		
		// reload on SIGHUP as well (like Apache does)
		process.on('SIGHUP', function() {
			self.logDebug(3, "Caught SIGHUP, scheduling reload");
			self.reloadQueue.push( {} );
		});
		
		// track stats
		this.stats = {
			version: this.__version,
			process: {
				pid: process.pid,
				ppid: process.ppid || 0,
				argv: process.argv,
				execArgv: process.execArgv
			},
			system: {
				node: process.version,
				arch: process.arch,
				platform: process.platform,
				totalMemoryBytes: os.totalmem(),
				cores: os.cpus().length
			},
			totals: {
				requests: 0,
				sockets: 0,
				elapsed_ms: 0
			},
			cpu: {},
			mem: {}
		};
		this.lastStatsTime = 0;
		
		// listen on some web server events for tracking stats
		this.web.on('socket', function(socket) {
			// new socket opened
			self.stats.totals.sockets++;
		});
		this.web.on('metrics', function(metrics, args) {
			// request completed
			self.stats.totals.requests++;
			self.stats.totals.elapsed_ms += metrics.perf.total || 0;
			
			// augment recent requests by inserting app id into metrics (dirty hack)
			metrics.app_id = args.request.headers['x-app'] || '';
		});
		
		// ticks
		this.server.on('tick', this.tick.bind(this));
		
		// setup apps
		this.apps = {};
		this.routes = [];
		this.plugins = [];
		
		// force an initial reload of all apps
		this.reloadApps( {}, function(err) {
			if (err) return callback(err);
			
			async.eachSeries( self.config.get('plugins') || [],
				async.ensureAsync( function(file, callback) {
					// load plugin and allow it to startup
					self.logDebug(4, "Loading plugin: " + file);
					var plugin = require( file );
					
					if (!plugin.__name) plugin.__name = Path.basename(file);
					plugin.config = self.server.config.get();
					plugin.server = self.server;
					plugin.web = self.web;
					plugin.apps = self.apps;
					plugin.logger = self.logger;
					plugin.debugLevel = self.debugLevel;
					plugin.logDebug = self.logDebug;
					plugin.logError = self.logError;
					plugin.logTransaction = self.logTransaction;
					
					self.plugins.push( plugin );
					
					if (plugin.startup) plugin.startup( callback );
					else callback();
				} ),
				callback
			); // eachSeries (plugins)
		}); // reloadApps
	},
	
	reloadApps: function(event, callback) {
		// reload all apps
		var self = this;
		var new_apps = {};
		var new_routes = [];
		this.logDebug(3, "Reloading all apps");
		
		glob( 'conf/apps/*.json', function(err, files) {
			if (err) {
				self.logError('fs', "Failed to glob for apps: " + err);
				return callback(err);
			}
			
			async.eachSeries( files,
				function(orig_file, callback) {
					// resolve symlinks
					fs.realpath(orig_file, function(err, file) {
						if (err) file = orig_file;
						self.logDebug(9, "Loading app config file: " + file);
						
						// load file
						fs.readFile( file, 'utf8', function(err, text) {
							if (err) {
								self.logError('fs', "Failed to read app config file: " + file + ": " + err);
								// don't bubble up error -- one failed config can't bring down the whole system
								return callback();
							}
							
							var json = null;
							try { json = JSON.parse(text); }
							catch (err) {
								self.logError('fs', "Failed to parse app config file: " + file + ": " + err);
								// don't bubble up error -- one failed config can't bring down the whole system
								return callback();
							}
							
							json.file = file;
							json.dir = Path.dirname(file);
							if (!json.name) json.name = Path.basename(file).replace(/\.\w+$/, '');
							if (!json.pool) json.pool = 'default';
							
							if (!json.routes && !json.static) {
								self.logError('fs', "App configuration missing required 'routes' and 'static' properties: " + file);
								// don't bubble up error -- one failed config can't bring down the whole system
								return callback();
							}
							
							// prep routes
							var headers = {};
							if (json.headers) {
								// headers are matched case-insensitively due to hostnames
								for (var key in json.headers) {
									headers[key] = new RegExp( json.headers[key], 'i' );
								}
							}
							
							var acl = false;
							if (json.acl) {
								try { acl = (json.acl === true) ? self.web.defaultACL : (new ACL(json.acl)); }
								catch (err) {
									self.logError('acl', "Failed to initialize ACL for app: " + json.name + ": " + err);
									// don't bubble up error -- one failed config can't bring down the whole system
									return callback();
								}
							}
							
							if (json.routes) {
								for (var uri_match in json.routes) {
									var script_path = Path.resolve( json.dir, json.routes[uri_match] );
									self.logDebug(9, "App route added for " + json.name + ": " + uri_match, {
										pool: json.pool,
										acl: acl ? acl.toString() : false,
										script: script_path
									});
									new_routes.push({
										regex: new RegExp(uri_match),
										headers: headers,
										acl: acl,
										type: 'script',
										app_id: json.name,
										pool_id: json.pool,
										script: script_path
									});
								}
							}
							if (json.static) {
								for (var uri_match in json.static) {
									var base_path = Path.resolve( json.dir, json.static[uri_match] );
									self.logDebug(9, "Static route added for " + json.name + ": " + uri_match, {
										pool: json.pool,
										acl: acl ? acl.toString() : false,
										path: base_path
									});
									new_routes.push({
										regex: new RegExp(uri_match),
										headers: headers,
										acl: acl,
										type: 'static',
										app_id: json.name,
										base_path: base_path
									});
								}
							}
							
							new_apps[ json.name ] = json;
							callback();
						}); // fs.readFile
					}); // fs.realpath
				},
				function() {
					// phase 2
					
					// swap in new apps (save route swap until the end)
					self.apps = new_apps;
					
					// make pool changes
					var new_pools = Tools.copyHash( self.config.get('pools'), true );
					
					for (var key in self.apps) {
						var app = self.apps[key];
						if (app.pools) {
							for (var app_id in app.pools) {
								new_pools[app_id] = Tools.copyHash( app.pools[app_id], true );
							}
						}
					}
					
					// make sure all pools load the correct worker
					for (var pool_id in new_pools) {
						new_pools[pool_id].script = "lib/worker.js";
					}
					
					// remove dead pools
					for (var pool_id in self.pm.getPools()) {
						if (!(pool_id in new_pools)) {
							self.logDebug(3, "Removing pool: " + pool_id);
							self.pm.removePool( pool_id, function() {} ); // no-op callback
						}
					}
					
					// refresh existing pools
					for (var pool_id in self.pm.getPools()) {
						if (pool_id in new_pools) {
							self.logDebug(3, "Refreshing pool: " + pool_id);
							var pool = self.pm.getPool( pool_id );
							
							// update pool's config
							delete new_pools[pool_id]['uri_match']; // we do the routing ourselves
							Tools.mergeHashInto( pool.config, new_pools[pool_id] ); // FUTURE: deal with removed props
							self.augmentPoolConfig( pool_id, pool.config );
							
							// request rolling restart (background operation, no callback)
							pool.requestRestart();
						}
					}
					
					// add new pools
					var pools_to_create = [];
					for (var pool_id in new_pools) {
						if (!self.pm.getPool(pool_id)) {
							pools_to_create.push([ pool_id, new_pools[pool_id] ]);
						}
					}
					
					async.eachSeries( pools_to_create,
						function(args, callback) {
							var pool_id = args[0];
							var pool_config = args[1];
							self.logDebug(3, "Adding pool: " + pool_id, pool_config);
							
							// update pool's config
							self.augmentPoolConfig( pool_id, pool_config );
							
							// create it!
							var pool = self.pm.createPool( pool_id, pool_config, callback );
							
							// receive messages from children
							pool.on('message', function(message) {
								// received message sent from worker
								// message.pid is the PID of the sender
								// message.data is the raw user-defined data
								var pid = message.pid || 0;
								var data = message.data || {};
								var worker = pool.getWorker(pid);
								if (!worker) return; // race condition with shutdown perhaps
								
								switch (data.cmd) {
									case 'stats':
										// stats from child
										worker.pn_stats = data.stats;
									break;
								} // switch cmd
							}); // message
							
							// handle child crashes
							pool.on('crash', function(event) {
								self.logError('child', "Worker crashed in pool: " + pool_id, event);
								
								// debug mode behavior: remove pool to prevent reload loop
								if (self.server.debug) {
									self.logDebug(2, "Removing pool until next reload: " + pool_id);
									self.pm.removePool( pool_id, function() {} ); // no-op callback
									
									// optional desktop notificiation
									if (self.server.config.get('notify')) {
										require('node-notifier').notify({
											title: 'PoolNoodle App Crash',
											message: 'Worker PID ' + event.pid + ' from pool ' + pool_id + ' crashed with code ' + event.code + '. See console for details.',
											sound: true
										});
									}
								} // debug
							});
						},
						function(err) {
							if (err) {
								self.logError('pool', "Failed to create pools: " + err);
							}
							
							// swap in new routes for request targeting
							self.routes = new_routes;
							
							// reset watcher for new file list
							self.setupWatchers();
							
							// allow plugins to hook reload
							async.eachSeries( self.plugins,
								async.ensureAsync( function(plugin, callback) {
									plugin.apps = self.apps;
									if (plugin.reload) {
										self.logDebug(4, "Reloading plugin: " + plugin.__name);
										plugin.reload( callback );
									}
									else callback();
								} ),
								function() {
									if (self.plugins.length) self.logDebug(3, "Reload complete");
									callback();
								}
							); // eachSeries (plugins)
						}
					); // eachSeries (new pools)
				}
			); // eachSeries (files)
		}); // glob
	},
	
	setupWatchers: function() {
		// setup fs watchers
		var self = this;
		if (!this.config.get('watcher_enabled')) return;
		var cooldown_ms = this.config.get('watcher_cooldown_ms') || 500;
		
		// close previous watchers
		if (this.watchers && this.watchers.length) {
			this.watchers.forEach( function(watcher) { watcher.close(); } );
		}
		if (this.watchTimer) {
			clearTimeout( this.watchTimer );
		}
		
		this.watchers = [];
		this.watchTimer = null;
		
		// watch all app conf files (originals, not symlinks)
		var files = [];
		for (var app_id in this.apps) {
			files.push( this.apps[app_id].file );
		}
		
		// watch the conf/apps dir too
		files.push( Path.resolve('conf/apps') );
		
		// watch all scripts too
		self.routes.forEach( function(route) {
			if (route.script) files.push( route.script );
		});
		
		var need_rewatch = false;
		
		async.eachSeries( files,
			function(file, callback) {
				fs.stat( file, function(err, stats) {
					if (err) {
						self.logError('watcher', "Failed to stat file: " + file + ": " + err);
						return callback();
					}
					
					var opts = {
						persistent: false,
						recursive: false,
						encoding: 'utf8'
					};
					
					var watcher = fs.watch( file, opts, function(type, filename) {
						if (!self.watchTimer) {
							// make sure mtime has actually changed (could be noise)
							fs.stat( file, function(err, new_stats) {
								if (!new_stats) {
									new_stats = { mtime: new Date(0) };
								}
								
								if (new_stats.mtime.getTime() != stats.mtime.getTime()) {
									self.logDebug(3, "Detected file change, scheduling reload in " + cooldown_ms + "ms", {
										type: type,
										path: file,
										filename: filename
									});
									
									self.watchTimer = setTimeout( function() {
										self.watchTimer = null;
										self.reloadQueue.push({});
									}, cooldown_ms );
								} // mtime changed
								else {
									// no actual change, but watcher is spoiled, so need to recreate all
									need_rewatch = true;
								}
							} ); // fs.stat
						}
					} ); // fs.watch
					
					self.watchers.push( watcher );
					callback();
				} ); // fs.stat
			},
			function() {
				if (need_rewatch && !self.watchTimer) {
					self.logDebug(9, "Detected filesystem noise, reinitializing watchers");
					setTimeout( function() { self.setupWatchers(); }, 1 );
				}
			}
		); // async.eachSeries
	},
	
	augmentPoolConfig: function(pool_id, pool_config) {
		// customize worker pool configuration
		pool_config._data = {
			serverConfig: this.server.config.get(),
			config: this.config.get(),
			apps: {}
		};
		
		for (var key in this.apps) {
			var app = this.apps[key];
			if (app.pool == pool_id) pool_config._data.apps[key] = app;
		}
	},
	
	handle_request: function(args, callback) {
		// handle incoming http request
		var self = this;
		var request = args.request;
		
		// disallow new requests during shutdown
		if (this.server.shut) {
			return callback( 
				"500 Internal Server Error", 
				{ 'Content-Type': "text/html" }, 
				"ERROR: Server is shutting down.\n" 
			);
		}
		
		// allow plugins to intercept requests
		async.eachSeries(
			this.plugins.filter( function(plugin) { 
				return !!plugin.handler; 
			} ),
			async.ensureAsync( function(plugin, callback) {
				args.perf.begin( plugin.__name );
				plugin.handler( args, function() {
					args.perf.end( plugin.__name );
					
					// see if plugin intercepted or no
					if (arguments[0]) {
						var err = new Error("Intercepted");
						err.arguments = Array.from(arguments);
						callback( err );
					}
					else callback();
				} ); 
			} ),
			function(err) {
				if (err) {
					// plugin has intercepted request and replaced the response
					return callback.apply( null, err.arguments );
				}
				
				// proceed to actual request processing
				self.process_request(args, callback);
			}
		); // eachSeries (plugins)
	},
	
	process_request: function(args, callback) {	
		// figure out which pool request belongs to
		var self = this;
		var request = args.request;
		
		args.perf.begin('route');
		var route = null;
		var chosen_route = null;
		var uri = args.request.url.replace(/\?.*$/, '');
		
		for (var idx = 0, len = this.routes.length; idx < len; idx++) {
			route = this.routes[idx];
			if (uri.match(route.regex)) {
				// check headers too
				var good = true;
				for (var key in route.headers) {
					if (!request.headers[key] || !request.headers[key].match(route.headers[key])) good = false;
				}
				if (good) {
					chosen_route = route;
					idx = len;
				}
			} // uri matches
		} // foreach route
		
		if (chosen_route) {
			// route has: regex, headers, acl, type, app_id, pool_id, script OR path
			route = chosen_route;
			args.request.headers['x-app'] = route.app_id;
			
			if (route.acl) {
				if (route.acl.checkAll(args.ips)) {
					// acl pass
					this.logDebug(9, "ACL allowed request for " + route.app_id, {
						ips: args.ips,
						acl: route.acl.toString()
					});
				}
				else {
					// acl rejection
					this.logError(403, "Forbidden: IP addresses rejected by ACL: " + route.app_id, {
						ips: args.ips,
						acl: route.acl.toString(),
						useragent: args.request.headers['user-agent'] || '',
						referrer: args.request.headers['referer'] || '',
						cookie: args.request.headers['cookie'] || '',
						url: this.web.getSelfURL(args.request, args.request.url) || args.request.url
					});
					
					return callback( 
						"403 Forbidden", 
						{ 'Content-Type': "text/html" }, 
						"403 Forbidden: ACL disallowed request.\n"
					);
				} // acl reject
			} // acl
			
			if (route.type == 'script') {
				// app script route (child pool delegation)
				this.logDebug(9, "Routing app request to " + route.app_id + ": " + uri, {
					pool: route.pool_id,
					script: route.script
				});
				
				// infuse args with our metadata for this request
				args.params._pn_data = {
					app_id: route.app_id,
					script: route.script
				};
				
				// delegate!
				var pool = this.pm.getPool( route.pool_id );
				args.perf.end('route');
				if (!pool) {
					return callback( 
						"500 Internal Server Error", 
						{ 'Content-Type': "text/html" }, 
						"ERROR: Pool not found: " + route.pool_id + "\n" 
					);
				}
				
				pool.delegateRequest( args, callback );
			}
			else if (route.type == 'static') {
				// static route (handle in parent)
				var file = Path.join( route.base_path, uri.replace(route.regex, '') ).replace(/\/$/, '');
				var has_trailing_slash = !!uri.match(/\/$/);
				
				this.logDebug(9, "Routing static request for " + route.app_id + ": " + uri, {
					base_path: route.base_path,
					file: file
				});
				
				fs.stat( file, function(err, stats) {
					if (err) {
						// could not stat file
						args.perf.end('route');
						return callback( '404 Not Found', {}, "Error: HTTP 404 Not Found" );
					}
					if (stats.isDirectory()) {
						if (!has_trailing_slash) {
							// redirect to slashified URL
							args.perf.end('route');
							return callback( '301 Moved Permanently', { Location: uri + '/' }, "" );
						}
						else {
							// allow file server to add index.html
							file += '/';
						}
					}
					
					// perform internal redirect to file
					args.internalFile = file;
					args.perf.end('route');
					callback(false);
				}); // fs.stat
			} // static
		}
		else {
			// no route found, fallback to generic global static
			args.perf.end('route');
			callback(false);
		}
	},
	
	handle_stats: function(args, callback) {
		// send back stats for all pools
		this.stats.system.uptime = os.uptime();
		this.stats.system.load = os.loadavg();
		this.stats.web = this.web.getStats();
		this.stats.apps = this.apps;
		this.stats.pools = {};
		this.stats.workers = [];
		
		// add ports from web server (FUTURE: add these in pixl-server-web)
		if (!this.stats.web.server.ports) {
			this.stats.web.server.ports = [
				this.web.config.get('http_port')
			];
			if (this.web.config.get('https')) {
				this.stats.web.server.ports.push( this.web.config.get('https_port') );
			}
		}
		
		// get stats from pools and workers
		for (var pool_id in this.pm.getPools()) {
			var pool = this.pm.getPool(pool_id);
			this.stats.pools[pool_id] = pool.getStates();
			
			var workers = pool.getWorkers();
			for (var pid in workers) {
				var worker = workers[pid];
				this.stats.workers.push({
					pid: pid,
					pool_id: pool_id,
					state: worker.state,
					// num_requests_served: worker.num_requests_served,
					num_active_requests: worker.num_active_requests,
					stats: worker.pn_stats || {}
				});
			} // foreach pid
		} // foreach pool
		
		// send to client in JSON format
		callback( this.stats );
	},
	
	tick: function() {
		// called once per second, more or less
		var now = Tools.timeNow();
		
		// broadcast stats every 10s
		if (now - this.lastStatsTime >= 10) {
			this.lastStatsTime = now;
			var cpu = process.cpuUsage();
			if (this.lastCPU) {
				var user_raw = cpu.user - this.lastCPU.user;
				var system_raw = cpu.system - this.lastCPU.system;
				this.stats.cpu.pct = (user_raw + system_raw) / 100000;
			}
			this.lastCPU = cpu;
			this.stats.mem = process.memoryUsage();
		}
	},
	
	shutdown: function(callback) {
		// shutdown service
		var self = this;
		this.logDebug(3, "Shutting down PoolNoodle");
		
		// close watchers
		if (this.watchers && this.watchers.length) {
			this.watchers.forEach( function(watcher) { watcher.close(); } );
		}
		if (this.watchTimer) {
			clearTimeout( this.watchTimer );
		}
		
		async.eachSeries( this.plugins,
			async.ensureAsync( function(plugin, callback) {
				self.logDebug(3, "Shutting down plugin: " + plugin.__name);
				
				if (plugin.shutdown) plugin.shutdown( callback );
				else callback();
			} ),
			function() {
				self.logDebug(2, "Shutdown complete");
				callback();
			}
		); // eachSeries
	}
	
});
