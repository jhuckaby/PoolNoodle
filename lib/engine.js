// PoolNoodle Server Component
// Copyright (c) 2018 - 2021 Joseph Huckaby
// Released under the MIT License

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const Path = require('path');
const Querystring = require('querystring');

const ACL = require('pixl-acl');
const Class = require("class-plus");
const Component = require("pixl-server/component");
const Tools = require("pixl-tools");

const async = Tools.async;
const glob = Tools.glob;
const mkdirp = Tools.mkdirp;

module.exports = Class({
	
	__mixins: [
		require('./proxy.js')
	],
	__version: require('../package.json').version,
	
	web: null,
	pm: null,
	apps: null,
	routes: null,
	rewrites: null,
	plugins: null,
	stats: null,
	watchers: null,
	watchTimer: null
	
},
class PoolNoodle extends Component {
	
	startup(callback) {
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
		
		// register a handler for HTTP OPTIONS (for CORS preflight)
		this.web.addMethodHandler( "OPTIONS", "CORS Preflight", this.corsPreflight.bind(this) );
		
		// catch all requests
		this.web.addURIHandler( /.+/, 'PoolNoodle', this.handle_request.bind(this) );
		
		// reloader queue (single thread)
		this.reloadQueue = async.queue( this.reloadApps.bind(this), 1 );
		
		// reload on main config reload
		this.server.config.on('reload', function() {
			self.reloadQueue.push( {} );
		});
		
		// reload on SIGUSR2 (AdMission uses this!  DO NOT REMOVE!)
		process.on('SIGUSR2', function() {
			self.logDebug(3, "Caught SIGUSR2, scheduling reload");
			self.reloadQueue.push( {} );
		});
		
		// track stats
		this.stats = {
			version: this.__version,
			process: {
				pid: process.pid,
				ppid: process.ppid || 0,
				argv: process.argv,
				execArgv: process.execArgv,
				cpu: { pct: 0 },
				mem: { rss: 0 }
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
			cpu: { pct: 0 },
			mem: { rss: 0 },
			apps: {},
			routes: {},
			plugins: {}
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
			metrics.route_id = args.request.headers['x-route'] || '';
			if (args.request.headers['x-plugin']) metrics.plugin = args.request.headers['x-plugin'];
			
			// update app-specific stats
			if (metrics.app_id && self.stats.apps[ metrics.app_id ]) {
				var app_stats = self.stats.apps[ metrics.app_id ];
				app_stats.count++;
				app_stats.total += metrics.perf.total || 0;
				if (app_stats.active) app_stats.active--;
				app_stats.last = Tools.timeNow();
				if (!metrics.counters) metrics.counters = {};
				app_stats.bytes_in += metrics.counters.bytes_in || 0;
				app_stats.bytes_out += metrics.counters.bytes_out || 0;
			}
			
			// update route-specific stats
			if (metrics.route_id && self.stats.routes[ metrics.route_id ]) {
				var route_stats = self.stats.routes[ metrics.route_id ];
				route_stats.count++;
				route_stats.total += metrics.perf.total || 0;
				if (route_stats.active) route_stats.active--;
				route_stats.last = Tools.timeNow();
				if (!metrics.counters) metrics.counters = {};
				route_stats.bytes_in += metrics.counters.bytes_in || 0;
				route_stats.bytes_out += metrics.counters.bytes_out || 0;
			}
			
			// update plugin-specific stats (if plugin intercepted request)
			if (metrics.plugin && self.stats.plugins[ metrics.plugin ]) {
				var plugin_stats = self.stats.plugins[ metrics.plugin ];
				plugin_stats.count++;
				plugin_stats.sec++;
				plugin_stats.total += metrics.perf.total || 0;
				plugin_stats.last = Tools.timeNow();
				if (!metrics.counters) metrics.counters = {};
				plugin_stats.bytes_in += metrics.counters.bytes_in || 0;
				plugin_stats.bytes_out += metrics.counters.bytes_out || 0;
			}
		});
		
		// ticks
		this.server.on('tick', this.tick.bind(this));
		this.server.on('minute', this.minute.bind(this));
		
		// archive logs daily at midnight
		this.server.on('day', function() {
			self.archiveLogs();
		} );
		
		// setup apps
		this.apps = {};
		this.routes = [];
		this.rewrites = [];
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
					self.stats.plugins[ plugin.__name ] = { id: plugin.__name, total: 0, count: 0, sec: 0, active: 0, last: 0, bytes_in: 0, bytes_out: 0 };
					
					if (plugin.startup) plugin.startup( callback );
					else callback();
				} ),
				callback
			); // eachSeries (plugins)
		}); // reloadApps
	}
	
	corsPreflight(args, callback) {
		// handler for HTTP OPTIONS calls (CORS preflight)
		callback( "200 OK", 
			{
				'Access-Control-Allow-Origin': args.request.headers['origin'] || "*",
				'Access-Control-Allow-Methods': "POST, PUT, GET, HEAD, DELETE, OPTIONS",
				'Access-Control-Allow-Headers': args.request.headers['access-control-request-headers'] || "*",
				'Access-Control-Max-Age': "86400",
				'Content-Length': "0"
			},
			null
		);
	}
	
	reloadApps(event, callback) {
		// reload all apps
		var self = this;
		var new_apps = {};
		var new_routes = [];
		var new_rewrites = [];
		
		// clear app stats
		this.stats.apps = {};
		this.stats.routes = {};
		
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
							
							if (!json.routes && !json.static && !json.redirects && !json.proxies) {
								self.logError('fs', "App configuration must have at least one route: " + file);
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
							
							if (json.rewrites) {
								for (var uri_match in json.rewrites) {
									var uri = json.rewrites[uri_match];
									self.logDebug(9, "App rewrite added for " + json.name + ": " + uri_match, {
										uri_replace: uri
									});
									new_rewrites.push({
										regex: new RegExp(uri_match),
										headers: headers,
										app_id: json.name,
										uri_replace: uri
									});
								}
							} // json.rewrites
							
							if (json.routes) {
								if (Tools.isaHash(json.routes)) {
									// standard hash of uri --> path
									for (var uri_match in json.routes) {
										var script_path = Path.resolve( json.dir, json.routes[uri_match] );
										self.logDebug(9, "API route added for " + json.name + ": " + uri_match, {
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
								} // isaHash
								else if (Tools.isaArray(json.routes)) {
									// array of custom routes with options
									json.routes.forEach( function(params) {
										if (params.type == 'rewrite') {
											// special handling for rewrites
											self.logDebug(9, "App rewrite added for " + json.name + ": " + params.uri_match, params);
											new_rewrites.push( Tools.mergeHashes({
												regex: new RegExp(params.uri_match),
												headers: headers,
												app_id: json.name,
											}, params));
											return;
										} // rewrite
										
										var route = Tools.mergeHashes({
											regex: new RegExp(params.uri_match),
											headers: headers,
											acl: acl,
											type: params.type,
											app_id: json.name,
											pool_id: json.pool
										}, params);
										
										switch (params.type) {
											case 'script': 
												route.script = Path.resolve( json.dir, params.path );
											break;
											
											case 'static':
												route.base_path = Path.resolve( json.dir, params.path );
											break;
										} // switch type
										
										if (route.acl === true) {
											route.acl = acl || self.web.defaultACL;
										}
										else if (Tools.isaArray(route.acl) && !route.acl.checkAll) {
											try { route.acl = new ACL(route.acl); }
											catch (err) {
												self.logError('acl', "Failed to initialize route-specific ACL for app: " + json.name + ": " + err, route);
												// don't bubble up error -- one failed config can't bring down the whole system
												return callback();
											}
										}
										
										new_routes.push(route);
										
										self.logDebug(9, "Route added for " + json.name + ": " + params.uri_match, {
											pool: json.pool,
											acl: acl ? acl.toString() : false,
											type: params.type,
											params: params
										});
									} );
								} // isaArray
							} // json.routes
							
							if (json.proxies) {
								for (var uri_match in json.proxies) {
									var params = {};
									var proxy = new URL( json.proxies[ uri_match ] );
									params.target_protocol = proxy.protocol;
									params.target_hostname = proxy.hostname;
									params.target_port = parseInt( proxy.port ) || 0;
									if (!params.target_port && (params.target_protocol == 'http:')) params.target_port = 80;
									else if (!params.target_port && (params.target_protocol == 'https:')) params.target_port = 443;
									params.path_prefix = proxy.pathname;
									
									self.logDebug(9, "Proxy route added for " + json.name + ": " + uri_match, {
										pool: json.pool,
										acl: acl ? acl.toString() : false,
										params: params
									});
									new_routes.push( Tools.mergeHashes({
										regex: new RegExp(uri_match),
										headers: headers,
										acl: acl,
										type: 'proxy',
										app_id: json.name
									}, params));
								}
							} // json.proxies
							
							if (json.redirects) {
								for (var uri_match in json.redirects) {
									var location = json.redirects[uri_match];
									
									self.logDebug(9, "Redirect route added for " + json.name + ": " + uri_match, {
										acl: acl ? acl.toString() : false,
										location: location
									});
									new_routes.push({
										regex: new RegExp(uri_match),
										headers: headers,
										acl: acl,
										type: 'redirect',
										app_id: json.name,
										location: location
									});
								}
							} // json.redirects
							
							if (json.static) {
								for (var uri_match in json.static) {
									var base_path = Path.resolve( json.dir, json.static[uri_match] );
									self.logDebug(9, "Static route added for " + json.name + ": " + uri_match, {
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
							} // json.static
							
							new_apps[ json.name ] = json;
							self.stats.apps[ json.name ] = { id: json.name, total: 0, count: 0, sec: 0, active: 0, last: 0, bytes_in: 0, bytes_out: 0 };
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
							
							// swap in new routes and rewrites for request targeting
							self.rewrites = new_rewrites;
							self.routes = new_routes;
							
							// assign ID to each route (for stat tracking)
							self.routes.forEach( function(route, idx) {
								route.id = route.app_id + '-' + route.type;
								switch (route.type) {
									case 'script': route.id += '-' + Path.basename(route.script); break;
									case 'static': route.id += '-' + Path.basename(route.base_path); break;
									case 'proxy': route.id += '-' + route.target_hostname; break;
								}
								if (route.label) route.id += '-' + route.label;
								if (self.stats.routes[ route.id ]) route.id += '-' + Math.floor(idx + 1); // uniquify
								self.stats.routes[ route.id ] = { id: route.id, app: route.app_id, type: route.type, total: 0, count: 0, sec: 0, active: 0, last: 0, bytes_in: 0, bytes_out: 0 };
							} );
							
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
	}
	
	setupWatchers() {
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
	}
	
	augmentPoolConfig(pool_id, pool_config) {
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
	}
	
	handle_request(args, callback) {
		// handle incoming http request
		var self = this;
		var request = args.request;
		
		// disallow new requests during shutdown
		if (this.server.shut) {
			return callback( 
				"503 Service Unavailable", 
				{ 'Content-Type': "text/html" }, 
				"ERROR: HTTP 503 Service Unavailable (server shutting down).\n" 
			);
		}
		
		// make sure args.params is a hash (required because we add _pn_data to it)
		if (!Tools.isaHash(args.params)) {
			args.params = { data: args.params };
		}
		
		// allow plugins to intercept requests
		async.eachSeries(
			this.plugins.filter( function(plugin) { 
				return !!plugin.handler; 
			} ),
			async.ensureAsync( function(plugin, callback) {
				var plugin_stats = self.stats.plugins[ plugin.__name ];
				plugin_stats.active++;
				
				args.perf.begin( plugin.__name );
				plugin.handler( args, function() {
					args.perf.end( plugin.__name );
					plugin_stats.active--;
					
					// see if plugin intercepted or no
					if (arguments[0]) {
						var err = new Error("Intercepted");
						err.plugin = plugin;
						err.arguments = Array.from(arguments);
						callback( err );
					}
					else callback();
				} ); 
			} ),
			function(err) {
				if (err) {
					// plugin has intercepted request and replaced the response
					args.request.headers['x-plugin'] = err.plugin.__name;
					return callback.apply( null, err.arguments );
				}
				
				// proceed to actual request processing
				self.process_request(args, callback);
			}
		); // eachSeries (plugins)
	}
	
	process_request(args, callback) {	
		// figure out which pool request belongs to
		var self = this;
		var request = args.request;
		
		// first, allow URL to be rewritten
		args.perf.begin('rewrite');
		var ebrake = 0;
		
		for (var idx = 0, len = this.rewrites.length; idx < len; idx++) {
			var rewrite = this.rewrites[idx];
			if (request.url.match(rewrite.regex)) {
				// check headers too
				var good = true;
				for (var key in rewrite.headers) {
					if (!request.headers[key] || !request.headers[key].match(rewrite.headers[key])) good = false;
				}
				if (good) {
					var new_uri = request.url.replace(rewrite.regex, rewrite.uri_replace);
					this.logDebug(9, "URI rewrite applied for: " + rewrite.app_id, { old: request.url, new: new_uri });
					request.url = new_uri;
					idx = 0;
					
					// recreate query based on new rewritten URL
					args.query = {};
					if (request.url.match(/\?(.+)$/)) {
						args.query = Querystring.parse( RegExp.$1 );
					}
					
					if (++ebrake > 32) return callback( 
						"500 Internal Server Error", 
						{ 'Content-Type': "text/html" }, 
						"ERROR: Too many rewrites (32) on single request: " + rewrite.app_id + "\n" 
					);
				}
			} // uri matches
		} // foreach rewrite
		
		args.perf.end('rewrite');
		
		// now find the first matching app route
		args.perf.begin('route');
		var route = null;
		var chosen_route = null;
		var matches = null;
		var uri = request.url.replace(/\?.*$/, '');
		
		for (var idx = 0, len = this.routes.length; idx < len; idx++) {
			route = this.routes[idx];
			matches = uri.match(route.regex);
			if (matches) {
				// check headers too
				var good = true;
				for (var key in route.headers) {
					if (!request.headers[key] || !request.headers[key].match(route.headers[key])) good = false;
				}
				if (good) {
					chosen_route = route;
					args.matches = matches;
					idx = len;
				}
			} // uri matches
		} // foreach route
		
		if (!chosen_route) {
			// no route found, fallback to generic global static
			args.perf.end('route');
			return callback(false);
		}
		
		// route has: regex, headers, acl, type, app_id, pool_id, script OR path
		route = chosen_route;
		request.headers['x-app'] = route.app_id;
		request.headers['x-route'] = route.id;
		
		this.logDebug(9, "Chosen route: " + route.app_id + " (" + route.type + ")", { id: route.id });
		
		var app = this.apps[ route.app_id ] || {};
		
		// track app-specific metrics
		var app_stats = this.stats.apps[ route.app_id ];
		if (app_stats) {
			app_stats.sec++;
			app_stats.active++;
		}
		
		var route_stats = this.stats.routes[ route.id ];
		if (route_stats) {
			route_stats.sec++;
			route_stats.active++;
		}
		
		// rate limiting (app level and route level)
		var rate_limit_err = '';
		var rlm = this.config.get('rate_limit_multiplier') || 1;
		
		if (app.max_requests_per_sec && app_stats && ((app_stats.sec * rlm) > app.max_requests_per_sec)) {
			rate_limit_err = 'Exceeded app ' + route.app_id + ' maximum requests per second (' + Math.floor(app_stats.sec * rlm) + ' > ' + app.max_requests_per_sec + ')';
		}
		else if (app.max_concurrent_requests && app_stats && ((app_stats.active * rlm) > app.max_concurrent_requests)) {
			rate_limit_err = 'Exceeded app ' + route.app_id + ' maximum concurrent requests (' + Math.floor(app_stats.active * rlm) + ' > ' + app.max_concurrent_requests + ')';
		}
		else if (route.max_requests_per_sec && route_stats && ((route_stats.sec * rlm) > route.max_requests_per_sec)) {
			rate_limit_err = 'Exceeded route ' + route.id + ' maximum requests per second (' + Math.floor(route_stats.sec * rlm) + ' > ' + route.max_requests_per_sec + ')';
		}
		else if (route.max_concurrent_requests && route_stats && ((route_stats.active * rlm) > route.max_concurrent_requests)) {
			rate_limit_err = 'Exceeded route ' + route.id + ' maximum concurrent requests (' + Math.floor(route_stats.active * rlm) + ' > ' + route.max_concurrent_requests + ')';
		}
		
		// optional standard (draft-7) rate limit header
		if (app.max_requests_per_sec && app.rate_limit_headers && app_stats) {
			var remain = Math.max(0, app.max_requests_per_sec - (app_stats.sec * rlm) );
			args.response.setHeader('RateLimit', `limit=${app.max_requests_per_sec}, remaining=${remain}, reset=1`);
			args.response.setHeader('RateLimit-Policy', `${app.max_requests_per_sec};w=1`);
		}
		else if (route.max_requests_per_sec && route.rate_limit_headers && route_stats) {
			var remain = Math.max(0, route.max_requests_per_sec - (route_stats.sec * rlm) );
			args.response.setHeader('RateLimit', `limit=${route.max_requests_per_sec}, remaining=${remain}, reset=1`);
			args.response.setHeader('RateLimit-Policy', `${route.max_requests_per_sec};w=1`);
		}
		
		// optional custom thread limit header
		if (app.max_concurrent_requests && app.thread_limit_headers && app_stats) {
			var remain = Math.max(0, app.max_concurrent_requests - (app_stats.active * rlm) );
			args.response.setHeader('ThreadLimit', `limit=${app.max_concurrent_requests}, remaining=${remain}`);
		}
		else if (route.max_concurrent_requests && route.thread_limit_headers && route_stats) {
			var remain = Math.max(0, route.max_concurrent_requests - (route_stats.active * rlm) );
			args.response.setHeader('ThreadLimit', `limit=${route.max_concurrent_requests}, remaining=${remain}`);
		}
		
		if (rate_limit_err) {
			this.logError(429, rate_limit_err, {
				ips: args.ips,
				app: route.app_id,
				route: route.id,
				useragent: args.request.headers['user-agent'] || '',
				referrer: args.request.headers['referer'] || '',
				cookie: args.request.headers['cookie'] || '',
				url: this.web.getSelfURL(args.request, args.request.url) || args.request.url
			});
			
			return callback( 
				"429 Too Many Requests", 
				{ 'Content-Type': "text/html", 'Retry-After': "1" }, 
				"429 Too Many Requests: " + rate_limit_err + "\n"
			);
		} // rate limit err
		
		// check for force_https
		if ((route.force_https || app.force_https) && !request.headers.ssl) {
			request.headers.ssl = 1; // force SSL redirect url
			var redirect_url = this.web.getSelfURL(request, request.url);
			this.logDebug(9, "Route/app requires HTTPS (" + route.app_id + "), sending redirect", { redirect_url });
			
			return callback( 
				"301 Moved Permanently", 
				{ 'Location': redirect_url }, 
				"" // empty body
			);
		} // force_https
		
		// now check ACL
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
					app: route.app_id,
					route: route.id,
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
				if ('ttl' in route) args.internalTTL = route.ttl;
				args.perf.end('route');
				callback(false);
			}); // fs.stat
		} // static
		else if (route.type == 'redirect') {
			// redirect to custom URL, which may use URI match groups
			// (handle in parent)
			var url = route.location.replace(/\$(\d+)/g, function(m_all, m_g1) {
				var value = args.matches[ parseInt(m_g1) ];
				return route.encode ? encodeURIComponent(value) : value;
			});
			var status = route.status || "302 Found";
			
			args.perf.end('route');
			return callback( status, { Location: url }, null );
		}
		else if (route.type == 'proxy') {
			// proxy route (handle in parent)
			this.handle_proxy(args, route, callback);
		} // proxy
	}
	
	handle_stats(args, callback) {
		// send back stats for all pools
		var stats = this.stats;
		
		if (!args.query.extended) {
			// prune verbose objects
			stats = Tools.copyHash(this.stats, true);
			if (stats.web) {
				delete stats.web.sockets;
				delete stats.web.recent;
			}
		}
		
		// send to client in JSON format
		callback( stats );
	}
	
	tick() {
		// called once per second, more or less
		var now = Tools.timeNow();
		
		// gather stats every 10s
		if (now - this.lastStatsTime >= 10) {
			this.lastStatsTime = now;
			this.gatherStats();
		}
		
		// reset current second counts in app/plugin stats
		for (var app_id in this.stats.apps) {
			var app_stats = this.stats.apps[ app_id ];
			app_stats.req_sec = app_stats.sec;
			app_stats.sec = 0;
		}
		for (var route_id in this.stats.routes) {
			var route_stats = this.stats.routes[ route_id ];
			route_stats.req_sec = route_stats.sec;
			route_stats.sec = 0;
		}
		for (var plugin_id in this.stats.plugins) {
			var plugin_stats = this.stats.plugins[ plugin_id ];
			plugin_stats.req_sec = plugin_stats.sec;
			plugin_stats.sec = 0;
		}
	}
	
	gatherStats() {
		// get detailed stats, called every 10s
		var cpu = process.cpuUsage();
		if (this.lastCPU) {
			var user_raw = cpu.user - this.lastCPU.user;
			var system_raw = cpu.system - this.lastCPU.system;
			this.stats.process.cpu.pct = (user_raw + system_raw) / 100000;
		}
		this.lastCPU = cpu;
		this.stats.process.mem = process.memoryUsage();
		
		this.stats.system.uptime = os.uptime();
		this.stats.system.load = os.loadavg();
		this.stats.web = this.web.getStats();
		this.stats.pools = {};
		this.stats.workers = [];
		
		// calculate total cpu/memory (includes all workers)
		this.stats.cpu = Tools.copyHash( this.stats.process.cpu, true );
		this.stats.mem = Tools.copyHash( this.stats.process.mem, true );
		
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
				
				if (worker.pn_stats) {
					if (worker.pn_stats.cpu) {
						for (var key in worker.pn_stats.cpu) {
							if (!(key in this.stats.cpu)) this.stats.cpu[key] = 0;
							this.stats.cpu[key] += worker.pn_stats.cpu[key] || 0;
						}
					} // pn_stats.cpu
					if (worker.pn_stats.mem) {
						for (var key in worker.pn_stats.mem) {
							if (!(key in this.stats.mem)) this.stats.mem[key] = 0;
							this.stats.mem[key] += worker.pn_stats.mem[key] || 0;
						}
					} // pn_stats.mem
				} // worker.pn_stats
			} // foreach pid
		} // foreach pool
	}
	
	minute() {
		// called once per minute
		if (this.config.get('log_stats')) {
			var stats = Tools.copyHash(this.stats, true);
			if (stats.web) {
				delete stats.web.sockets;
				delete stats.web.recent;
			}
			
			this.logger.print({ 
				component: this.__name,
				category: 'stats', 
				code: 'minute', 
				msg: "Minute Stats", 
				data: stats 
			});
		}
	}
	
	archiveLogs() {
		// archive all logs (called once daily)
		var self = this;
		var src_spec = this.server.config.get('log_dir') + '/*.log';
		var dest_path = this.server.config.get('log_archive_path');
		
		if (dest_path) {
			this.logDebug(4, "Archiving logs: " + src_spec + " to: " + dest_path);
			// generate time label from previous day, so just subtracting 30 minutes to be safe
			var epoch = Tools.timeNow(true) - 1800;
			
			this.logger.archive(src_spec, dest_path, epoch, function(err) {
				if (err) self.logError('maint', "Failed to archive logs: " + err);
				else self.logDebug(4, "Log archival complete");
			});
		}
	}
	
	getAllChildStates() {
		// get merged states for all children, all pools
		var all_states = { startup: 0, active: 0, maint: 0, shutdown: 0 };
		
		for (var pool_id in this.pm.getPools()) {
			var pool = this.pm.getPool(pool_id);
			var states = pool.getStates();
			for (var key in states) {
				all_states[key] += states[key];
			}
		}
		
		return all_states;
	}
	
	shutdown(callback) {
		// shutdown service
		var self = this;
		
		// close watchers
		if (self.watchers && self.watchers.length) {
			self.watchers.forEach( function(watcher) { watcher.close(); } );
		}
		if (self.watchTimer) {
			clearTimeout( self.watchTimer );
		}
		
		var states = self.getAllChildStates();
		if (states.startup || states.maint || states.shutdown) {
			this.logDebug(3, "Delaying shutdown sequence while children are in non-active states", states);
		}
		
		// make sure all children are in a good state to shutdown
		async.whilst(
			function() {
				var states = self.getAllChildStates();
				return states.startup || states.maint || states.shutdown;
			},
			function(callback) {
				setTimeout( function() { callback(); }, 250 );
			},
			function() {
				self.logDebug(3, "Shutting down PoolNoodle");
				
				async.eachSeries( self.plugins,
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
		); // whilst
	}
	
});
