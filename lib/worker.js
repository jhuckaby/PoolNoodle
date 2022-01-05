// PoolNoodle Worker
// Runs in separate process, launched via pixl-server-pool
// Copyright (c) 2018 Joseph Huckaby
// Released under the MIT License

const Path = require('path');
const Logger = require('pixl-logger');
const Tools = require('pixl-tools');

const async = Tools.async;
const mkdirp = Tools.mkdirp;
const glob = Tools.glob;

module.exports = {
	
	__name: "NoodleWorker",
	__version: require('../package.json').version,
	
	serverConfig: null,
	config: null,
	apps: null,
	scripts: null,
	stats: null,
	tickTimer: null,
	
	startup: function(worker, callback) {
		// child is starting up
		var self = this;
		this.worker = worker;
		
		// set process.title for `ps -ef` output
		process.title = this.__name + ": " + worker.config.id;
		
		// we should have been passed a bunch of data from the parent
		// _data: { serverConfig, config, apps }
		Tools.mergeHashInto( this, worker.config._data );
		
		// setup logging (share log system with parent)
		this.logger = new Logger(
			Path.join( (this.serverConfig.log_dir || '.'), (this.serverConfig.worker_log_filename || this.serverConfig.log_filename || 'worker.log') ),
			this.serverConfig.log_columns || ['hires_epoch', 'date', 'hostname', 'pid', 'component', 'category', 'code', 'msg', 'data']
		);
		this.logger.set('debugLevel', this.serverConfig.worker_debug_level || this.serverConfig.debug_level || 1 );
		this.logger.set('sync', true);
		this.logger.set('color', !!this.serverConfig.color );
		
		if (this.serverConfig.echo || this.serverConfig.worker_echo) {
			// echo child logs to console (use stderr, because stdout is used for JSON comm)
			this.logger.set('echo', true);
			this.logger.set('echoer', function(line, cols, args) {
				process.stderr.write( args.color ? (this.colorize(cols) + "\n") : line );
			});
		}
		
		this.worker.attachLogAgent( this.logger );
		
		this.logDebug(2, this.__name + " v" + this.__version + " Starting Up", {
			pid: process.pid,
			ppid: process.ppid || 0,
			node: process.version,
			arch: process.arch,
			platform: process.platform,
			argv: process.argv,
			execArgv: process.execArgv
		});
		
		// track stats
		this.stats = {
			start_time: Tools.timeNow(),
			num_requests: 0,
			total_elapsed_ms: 0,
			cpu: {},
			mem: {}
		};
		this.lastStatsTime = 0;
		
		// tick seconds
		this.tickTimer = setInterval( this.tick.bind(this), 1000 );
		
		// load apps
		this.scripts = {};
		this.plugins = [];
		
		for (var app_id in this.apps) {
			var app = this.apps[app_id];
			this.logDebug(3, "Loading app: " + app_id, app);
			
			if (app.routes && Tools.isaHash(app.routes)) {
				for (var uri_match in app.routes) {
					var file = Path.resolve( app.dir, app.routes[uri_match] );
					this.logDebug(4, "Loading " + app_id + " script: " + file);
					var script = require( file );
					
					if (!script.__name) script.__name = app_id + '-' + Path.basename(file);
					script.config = app;
					script.logger = this.logger;
					script.debugLevel = this.debugLevel;
					script.logDebug = this.logDebug;
					script.logError = this.logError;
					script.logTransaction = this.logTransaction;
					script.serverConfig = this.serverConfig;
					
					if (app.log) {
						// custom log for app
						script.logger = new Logger( app.log.path, app.log.columns || ['hires_epoch', 'date', 'hostname', 'pid', 'component', 'category', 'code', 'msg', 'data'] );
						script.logger.set( 'debugLevel', app.log.level || this.logger.get('debugLevel') );
						if (app.log.args) script.logger.set( app.log.args );
					}
					
					this.scripts[ file ] = script;
				}
			} // foreach route
			else if (app.routes && Tools.isaArray(app.routes)) {
				app.routes.forEach( function(route) {
					if (route.type != 'script') return;
					
					var file = Path.resolve( app.dir, route.path );
					self.logDebug(4, "Loading " + app_id + " script: " + file);
					var script = require( file );
					
					if (!script.__name) script.__name = app_id + '-' + Path.basename(file);
					script.config = app;
					script.logger = self.logger;
					script.debugLevel = self.debugLevel;
					script.logDebug = self.logDebug;
					script.logError = self.logError;
					script.logTransaction = self.logTransaction;
					script.serverConfig = self.serverConfig;
					
					if (app.log) {
						// custom log for app
						script.logger = new Logger( app.log.path, app.log.columns || ['hires_epoch', 'date', 'hostname', 'pid', 'component', 'category', 'code', 'msg', 'data'] );
						script.logger.set( 'debugLevel', app.log.level || self.logger.get('debugLevel') );
						if (app.log.args) script.logger.set( app.log.args );
					}
					
					self.scripts[ file ] = script;
				} );
			}
		} // foreach app
		
		async.eachSeries( this.config.worker_plugins || [],
			function(file, callback) {
				// load plugin and allow it to startup
				self.logDebug(4, "Loading worker plugin: " + file);
				var plugin = require( file );
				
				if (!plugin.startup) {
					return callback( new Error("Failed to load worker Plugin: " + file + ": No startup function") );
				}
				
				if (!plugin.__name) plugin.__name = Path.basename(file);
				plugin.config = self.serverConfig;
				plugin.apps = self.apps;
				plugin.scripts = self.scripts;
				plugin.logger = self.logger;
				plugin.debugLevel = self.debugLevel;
				plugin.logDebug = self.logDebug;
				plugin.logError = self.logError;
				plugin.logTransaction = self.logTransaction;
				
				self.plugins.push( plugin );
				plugin.startup( callback );
			},
			function(err) {
				if (err) {
					self.logError('plugin', "Plugin startup has failed: " + err);
					return callback(err);
				}
				
				// now startup user scripts
				async.eachSeries( Object.keys(self.scripts),
					async.ensureAsync( function(file, callback) {
						var script = self.scripts[file];
						self.logDebug(3, "Starting up script: " + file);
						
						if (script.startup) script.startup( callback );
						else callback();
					} ),
					function() {
						self.logDebug(2, "Startup complete");
						callback();
					}
				); // eachSeries (scripts)
			}
		); // eachSeries (plugins)
	},
	
	handler: function(args, callback) {
		// handle request in child and fire callback
		var self = this;
		var data = args.params._pn_data;
		delete args.params._pn_data;
		var app_id = data.app_id;
		var file = data.script;
		var script = this.scripts[file];
		
		if (!script) {
			// should never happen
			return callback( 
				"500 Internal Server Error", 
				{ 'Content-Type': "text/html" }, 
				"ERROR: Script not loaded: " + file + "\n" 
			);
		}
		if (!script.handler) {
			return callback( 
				"500 Internal Server Error", 
				{ 'Content-Type': "text/html" }, 
				"ERROR: Script has no handler function: " + file + "\n" 
			);
		}
		
		this.logDebug(9, "Sending request: " + args.url + " to " + app_id + ": " + file, {
			headers: args.request.headers,
			ips: args.ips
		});
		
		// stuff app id into args for convenience
		args.app = app_id;
		
		// allow plugins to intercept requests
		async.eachSeries(
			this.plugins.filter( function(plugin) { 
				return !!plugin.handler; 
			} ),
			function(plugin, callback) {
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
			},
			function(err) {
				if (err) {
					// plugin has intercepted request and replaced the response
					return callback.apply( null, err.arguments );
				}
				
				// proceed to actual script handler
				args.perf.begin( app_id );
				script.handler( args, function() {
					// request complete, sniff result for perf and logging
					var elapsed_ms = args.perf.end( app_id );
					
					self.stats.num_requests++;
					self.stats.total_elapsed_ms += elapsed_ms;
					
					if ((arguments.length == 1) && (arguments[0] instanceof Error)) {
						// error
						self.logDebug(9, "Sending error response: " + arguments[0] );
					}
					else {
						// check for pixl-server-web style callbacks
						if ((arguments.length == 1) && (typeof(arguments[0]) == 'object')) {
							// json
							self.logDebug(9, "Sending JSON response", arguments[0]);
						}
						else if ((arguments.length == 3) && (typeof(arguments[0]) == "string")) {
							// status, headers, body
							self.logDebug(9, "Sending response: " + arguments[0], {
								headers: arguments[1] || {},
								bytes: arguments[2] ? arguments[2].length : 0
							});
						}
					}
					
					// passthrough to original callback
					callback.apply( null, Array.from(arguments) );
				} ); // script.handler
			}
		); // eachSeries (plugins)
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
			this.worker.sendMessage({
				cmd: 'stats',
				stats: this.stats
			});
		}
	},
	
	debugLevel: function(level) {
		// check if we're logging at or above the requested level
		return (this.logger.get('debugLevel') >= level);
	},
	
	logDebug: function(level, msg, data) { 
		this.logger.set( 'component', this.__name );
		this.logger.debug(level, msg, data); 
	},
	
	logError: function(code, msg, data) { 
		this.logger.set( 'component', this.__name );
		this.logger.error(code, msg, data); 
	},
	
	logTransaction: function(code, msg, data) { 
		this.logger.set( 'component', this.__name );
		this.logger.transaction(code, msg, data); 
	},
	
	shutdown: function(callback) {
		// child is shutting down
		var self = this;
		if (this.tickTimer) {
			clearTimeout( this.tickTimer );
			this.tickTimer = null;
		}
		
		async.eachSeries( Object.keys(this.scripts),
			async.ensureAsync( function(file, callback) {
				var script = self.scripts[file];
				self.logDebug(3, "Shutting down script: " + file);
				
				if (script.shutdown) script.shutdown( callback );
				else callback();
			} ),
			function() {
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
				); // eachSeries (plugins)
			}
		); // eachSeries (scripts)
	},
	
	emergencyShutdown: function(err) {
		// emergency shutdown (crash of some kind)
		var self = this;
		this.logError('crash', "Emergency shutdown: " + err, err.stack);
		
		Object.keys(this.scripts).forEach( function(file) {
			var script = self.scripts[file];
			if (script.emergencyShutdown) script.emergencyShutdown(err);
		} );
		
		this.plugins.forEach( function(plugin) {
			if (plugin.emergencyShutdown) plugin.emergencyShutdown(err);
		} );
		
		// do not call process.exit here
	}
	
};
