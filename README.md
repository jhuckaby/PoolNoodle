<p align="center"><img src="https://pixlcore.com/software/poolnoodle/images/logo-title-full.png" width="512"></p>

# Overview

**PoolNoodle** is a multi-process HTTP web server built on [pixl-server](https://github.com/jhuckaby/pixl-server), [pixl-server-web](https://github.com/jhuckaby/pixl-server-web) and [pixl-server-pool](https://github.com/jhuckaby/pixl-server-pool).  It manages multiple pools of child worker processes to handle application requests, while serving static files from the parent process.  Applications can easily be added by dropping in a single configuration file (or symlink), and everything is hot-reloaded with zero downtime.

## Features

- Supports multiple pools of worker processes for application routes.
- Distributes load across workers.
- Automatic hot-reload of apps on file change.
- Zero downtime reloads by round-robin child restarts.
- Process isolation so crashes don't bring down the whole server.
- Supports Plugins in the parent and child which can intercept requests.
- Applications can define custom routes to multiple Node.js script endpoints.
- Support for locking down apps via IPv4 and/or IPv6 ACLs.
- Optional desktop notifications for crashes.

## Table of Contents

<!-- toc -->
- [Usage](#usage)
	* [Installation](#installation)
	* [Configuration](#configuration)
		+ [Global Configuration](#global-configuration)
		+ [WebServer Configuration](#webserver-configuration)
		+ [PoolNoodle Configuration](#poolnoodle-configuration)
			- [Pools](#pools)
			- [Plugin Configuration](#plugin-configuration)
			- [stats_uri_match](#stats_uri_match)
			- [watcher_enabled](#watcher_enabled)
			- [watcher_cooldown_ms](#watcher_cooldown_ms)
	* [Applications](#applications)
		+ [Routes](#routes)
		+ [Scripts](#scripts)
			- [Script Methods](#script-methods)
			- [Script Additions](#script-additions)
			- [Script Logging](#script-logging)
			- [Custom Log](#custom-log)
		+ [Static Hosting](#static-hosting)
		+ [Redirects](#redirects)
		+ [Proxies](#proxies)
		+ [URL Rewrites](#url-rewrites)
		+ [Advanced Routing](#advanced-routing)
			- [Advanced API Routes](#advanced-api-routes)
			- [Advanced Static Hosting](#advanced-static-hosting)
			- [Advanced Redirects](#advanced-redirects)
			- [Advanced Proxies](#advanced-proxies)
			- [Advanced URL Rewrites](#advanced-url-rewrites)
		+ [Virtual Hosts](#virtual-hosts)
		+ [Custom Pools](#custom-pools)
		+ [Access Control Lists](#access-control-lists)
	* [Plugins](#plugins)
		+ [Worker Plugins](#worker-plugins)
	* [Command-Line Usage](#command-line-usage)
		+ [Debugging](#debugging)
		+ [Server Reboot](#server-reboot)
		+ [Upgrading](#upgrading)
	* [Status Page](#status-page)
		+ [Active Workers](#active-workers)
		+ [Open Sockets](#open-sockets)
		+ [Recent Requests](#recent-requests)
		+ [JSON Stats API](#json-stats-api)
			- [Web Server Stats](#web-server-stats)
- [Logging](#logging)
	* [Debug Log](#debug-log)
	* [Error Log](#error-log)
	* [Transaction Log](#transaction-log)
	* [Log Archives](#log-archives)
- [License](#license)

# Usage

## Installation

Please note that PoolNoodle currently only works on POSIX-compliant operating systems, which basically means Unix/Linux and OS X.  You'll need to have [Node.js](https://nodejs.org/en/download/) pre-installed on your server, then become root and type this:

```
curl -s https://raw.githubusercontent.com/jhuckaby/PoolNoodle/master/bin/install.js | node
```

This will install the latest stable release of PoolNoodle and all of its dependencies under: `/opt/poolnoodle/`

If you'd rather install it manually, here are the raw commands:

```
mkdir -p /opt/poolnoodle
cd /opt/poolnoodle
curl -L https://github.com/jhuckaby/PoolNoodle/archive/v1.0.0.tar.gz | tar zxvf - --strip-components 1
npm install
cp conf/sample-config.json conf/config.json
```

Replace `v1.0.0` with the desired PoolNoodle version from the [release list](https://github.com/jhuckaby/PoolNoodle/releases), or `master` for the head revision (unstable).

## Configuration

The main PoolNoodle configuration file is in JSON format, and can be found here:

```
/opt/poolnoodle/conf/config.json
```

Please edit this file directly.  It will not be touched by any upgrades.  A pristine copy of the default configuration can always be found here: `/opt/poolnoodle/conf/sample-config.json`.

Here is an example configuration:

```js
{
	"log_dir": "logs",
	"log_filename": "Server.log",
	"worker_log_filename": "Worker.log",
	"log_crashes": true,
	"pid_file": "logs/pid.txt",
	"debug_level": 9,
	"worker_debug_level": 9,
	"check_config_freq_ms": 1000,
	
	"PoolNoodle": {
		"stats_uri_match": "^/status/api",
		"watcher_enabled": true,
		"watcher_cooldown_ms": 500,
		
		"pools": {
			"default": {
				"min_children": 2,
				"max_children": 16,
				"max_concurrent_requests": 0,
				"max_requests_per_child": 0,
				"max_concurrent_launches": 1,
				"max_concurrent_maint": 1,
				"child_headroom_pct": 0,
				"child_busy_factor": 1,
				"startup_timeout_sec": 10,
				"shutdown_timeout_sec": 10,
				"request_timeout_sec": 0,
				"maint_timeout_sec": 0,
				"auto_maint": false
			}
		},
		
		"plugins": [],
		"worker_plugins": []
	},
	
	"WebServer": {
		"http_port": 3020,
		"http_htdocs_dir": "htdocs",
		"http_server_signature": "PoolNoodle 1.0",
		"http_gzip_text": true,
		"http_timeout": 30,
		"http_keep_alives": "default",
		"http_static_index": "index.html",
		"http_static_ttl": 86400,
		"http_clean_headers": true,
		"http_log_requests": true,
		"http_regex_log": ".+",
		"http_recent_requests": 100,
		"http_max_connections": 255,
		"http_default_acl": ["::1/128", "127.0.0.1/32", "169.254.0.0/16", "fe80::/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"],
		
		"https": false,
		"https_port": 3021,
		"https_cert_file": "conf/ssl.crt",
		"https_key_file": "conf/ssl.key",
		"https_force": 0,
		"https_timeout": 30,
		"https_header_detect": {
			"Front-End-Https": "^on$",
			"X-Url-Scheme": "^https$",
			"X-Forwarded-Protocol": "^https$",
			"X-Forwarded-Proto": "^https$",
			"X-Forwarded-Ssl": "^on$"
		}
	},
	
	"PoolManager": {
		"uncatch": true
	}
	
}
```

### Global Configuration

The top-level properties are all used by the [pixl-server](https://github.com/jhuckaby/pixl-server) daemon framework, with a couple exceptions noted below.  Please see the [pixl-server configuration](https://github.com/jhuckaby/pixl-server#configuration) docs for a list of all the available properties.  Here are brief descriptions of the ones from the sample configuration above:

| Property Name | Type | Description |
|---------------|------|-------------|
| `log_dir` | String | Directory path where event log will be stored.  Can be a fully-qualified path, or relative from the PoolNoodle base directory. |
| `log_filename` | String | Event log filename, joined with `log_dir`.  See [Logging](#logging) below. |
| `worker_log_filename` | String | Log filename used by worker processes, joined with `log_dir`.  See [Logging](#logging) below. |
| `log_crashes` | Boolean | Log uncaught exceptions to the main event log. |
| `pid_file` | String | Partial path to the PID file, used by the daemon (relative from the PoolNoodle base directory). |
| `debug_level` | Integer | Debug logging level, larger numbers are more verbose, 1 is quietest, 10 is loudest. |
| `worker_debug_level` | Integer | Separate debug logging level for the worker processes specifically. |
| `check_config_freq_ms` | Integer | Frequency at which to poll the main configuration file for changes, in milliseconds. |

### WebServer Configuration

The properties in the `WebServer` object are all used by the [pixl-server-web](https://github.com/jhuckaby/pixl-server-web) component.  Please see the [pixl-server-web configuration](https://github.com/jhuckaby/pixl-server-web#configuration) docs for a full description of all the properties, but here are a few that pertain specifically to PoolNoodle:

| Property Name | Type | Description |
|---------------|------|-------------|
| `http_port` | Integer | This is the port to listen on. The standard web port is 80, but note that only the root user can listen on ports below 1024. |
| `http_htdocs_dir` | String | This directory is used to serve static files, when no app route matches a request. |
| `http_server_signature` | String | This is the default `Server` header to send back to clients, when one is not included in the app response. |
| `http_gzip_text` | Boolean | Set this to `true` to compress text-based responses that aren't already compressed. |
| `http_timeout` | Integer | This is the HTTP idle timeout value in seconds.  This doubles as the Keep-Alive socket timeout as well. |
| `http_keep_alives` | String | This specifies the Keep-Alive mode in the web server.  Recommend you set this to the string `"default"`.  See the [pixl-server-web docs](https://github.com/jhuckaby/pixl-server-web#http_keep_alives) for details. |
| `http_log_requests` | Boolean | Set this to `true` if you want client HTTP requests to be logged as transactions.  See [Transaction Log](#transaction-log) for details. |
| `http_regex_log` | String | Use this feature to only log *some* requests, based on a URI regular expression match.  See [Logging](#logging) for details. |
| `http_recent_requests` | Integer | This is the number of recent requests to track in the stats.  See [JSON Stats API](#json-stats-api) below for details. |
| `http_max_connections` | Integer | This is the global maximum limit of simultaneous front-end client TCP connections.  Once this limit is reached, new sockets are rejected (hard-closed), and a `maxconns` error is logged. |
| `https` | Boolean | Set this to `true` if you want to enable SSL support, and serve HTTPS to the client. |

### PoolNoodle Configuration

The `PoolNoodle` object contains the configuration for the default pool of workers, Plugins, and a few miscellaneous parameters.  These are all explained below.

#### Pools

PoolNoodle works by routing requests to specific "pools" of worker processes, based on the URI and/or host.  Each pool can be configured however you like, and your applications point to a pool by it's ID.  By default, the configuration ships with a `default` pool configured like this:

```js
"pools": {
	"default": {
		"min_children": 2,
		"max_children": 16,
		"max_concurrent_requests": 0,
		"max_requests_per_child": 0,
		"max_concurrent_launches": 1,
		"max_concurrent_maint": 1,
		"child_headroom_pct": 0,
		"child_busy_factor": 1,
		"startup_timeout_sec": 10,
		"shutdown_timeout_sec": 10,
		"request_timeout_sec": 0,
		"maint_timeout_sec": 0,
		"auto_maint": false
	}
}
```

All the pool parameters here are passed directly to [pixl-server-pool](https://github.com/jhuckaby/pixl-server-pool#configuration), but here are descriptions of them all:

| Property Name | Default Value | Description |
|---------------|---------------|-------------|
| `min_children` | `1` | Minimum number of workers to allow (see [Auto-Scaling](https://github.com/jhuckaby/pixl-server-pool#auto-scaling)). |
| `max_children` | `1` | Maximum number of workers to allow (see [Auto-Scaling](https://github.com/jhuckaby/pixl-server-pool#auto-scaling)). |
| `max_concurrent_requests` | `0` | Maximum number of concurrent requests to allow (total across all workers, see [Max Concurrent Requests](https://github.com/jhuckaby/pixl-server-pool#max-concurrent-requests)). |
| `max_requests_per_child` | `0` | Maximum number of requests a worker can serve before it is cycled out (see [Max Requests Per Child](https://github.com/jhuckaby/pixl-server-pool#max-requests-per-child)). |
| `max_concurrent_launches` | `1` | Maximum number of concurrent children to launch (for both startup and auto-scaling). |
| `max_concurrent_maint` | `1` | Maximum number of concurrent children to allow in a maintenance state (see [Rolling Maintenance Sweeps](https://github.com/jhuckaby/pixl-server-pool#rolling-maintenance-sweeps)). |
| `child_headroom_pct` | `0` | Percentage of workers to over-allocate, for scaling purposes (see [Child Headroom](https://github.com/jhuckaby/pixl-server-pool#child-headroom). |
| `child_busy_factor` | `1` | Number of concurrent requests served by one child to consider it to be "busy" (see [Auto-Scaling](https://github.com/jhuckaby/pixl-server-pool#auto-scaling)). |
| `startup_timeout_sec` | `0` | Maximum time allowed for workers to start up.  If exceeded the process is killed and an error logged. |
| `shutdown_timeout_sec` | `10` | Maximum time allowed for workers to shut down.  If exceeded a SIGKILL is sent and an error logged. |
| `request_timeout_sec` | `0` | Maximum execution time allowed per worker request.  If exceeded a [HTTP 504](https://github.com/jhuckaby/pixl-server-pool#http-504-gateway-timeout) is sent. |
| `maint_timeout_sec` | `0` | Maximum time allowed per workers to complete maintenance.  If exceeded the worker is shut down and an error logged. |
| `auto_maint` | `false` | Set to `true` to automatically perform maintenance sweeps every N requests or N seconds (see [Rolling Maintenance Sweeps](https://github.com/jhuckaby/pixl-server-pool#rolling-maintenance-sweeps)). |
| `maint_method` | `'requests'` | When `auto_maint` is enabled this prop can be set to either `'requests'` or `'time'` (strings). |
| `maint_requests` | `1000` | When `maint_method` is set to `requests` this specifies the number of worker requests to count between maintenance sweeps. |
| `maint_time_sec` | `0` | When `maint_method` is set to `time` this specifies the number of seconds between maintenance sweeps (tracked per worker). |
| `exec_opts` | n/a | Optionally set the `uid` and/or `gid` of your child workers.  See [Child Spawn Options](https://github.com/jhuckaby/pixl-server-pool#child-spawn-options) for details on this. |

You can add as many additional pools as you like to the main configuration.  Just give them a unique ID (property key) like this:

```js
"pools": {
	"default": {
		"min_children": 2,
		"max_children": 16
	},
	"mycustompool": {
		"min_children": 1,
		"max_children": 1
	}
}
```

This example would launch two completely separate pools of worker processes, one with 2 - 16 processes (based on auto-scaling), and one with only a single worker process.  Your application routes can then target any of the worker pools for incoming requests.  See [Applications](#applications) below.

#### Plugin Configuration

PoolNoodle has the concept of "Plugins", which are custom code libraries that can hook the startup and request cycles.  They can run code at startup, and even intercept, filter or augment incoming requests, before your apps get them.  There are two types of Plugins, those that run in the parent (web server) process, and those than run in worker (child / app) processes.  They are configured by `plugins` and `worker_plugins` arrays, respectively:

```js
"plugins": [
	"/opt/sites/testapp/myplugin.js"
],
"worker_plugins": [
	"/opt/sites/testapp/myworkerplugin.js"
]
```

Each value in the arrays should be a fully-qualified filesystem path to your Plugins.  Each Plugin needs to be a valid Node.js script which can export special functions for hooking events.  See [Plugins](#plugins) below for more details on how to write your own Plugins.

#### stats_uri_match

If you would like to enable the [JSON Stats API](#json-stats-api), this property allows you to configure which URI activates the service.  It is formatted as a regular expression wrapped in a string, e.g. `^/status/api`, and is matched case-sensitively.  To disable the stats API, set this to Boolean `false` (or just omit it from your configuration, as it defaults to disabled).  The API is of course protected by an ACL.

For more details, see the [JSON Stats API](#json-stats-api) section below.  Note that the [Status Page](#status-page) requires that the stats API be set to `^/status/api` specifically, so change it at your own risk.

#### watcher_enabled

When `watcher_enabled` is set to true, all your application configuration files and scripts are actively monitored for changes, and will automatically reload.  This is great for both local development and live production deployments.

#### watcher_cooldown_ms

To combat filesystem event noise that can happen when using [fs.watch](https://nodejs.org/api/fs.html#fs_fs_watch_filename_options_listener), PoolNoodle employs a "cooldown" period.  Specifically, when a file change is detected, it ignores all further filesystem events for a few milliseconds (default 500).  This ensures that a duplicate reload doesn't occur.

## Applications

An "application" in PoolNoodle is a collection of routes that point to custom Node.js scripts, and is defined by a single JSON configuration file.  Your route scripts are preloaded and live in the pool worker processes.  Incoming requests that match your routes are passed to your scripts for processing, and your response is sent back to the client.  You can also define routes that point to static files.

Your scripts (and static files) can live wherever you want on the filesystem.  The only file you need to add to PoolNoodle is your application's JSON configuration file, which should be dropped into the `/opt/poolnoodle/conf/apps/` directory, and named with a `.json` suffix.  This can of course be a symlink.  Here is an example file:

```js
{
	"name": "testapp",
	"pool": "default",
	"routes": {
		"^/testapp/api": "/opt/sites/testapp/api.js"
	},
	"static": {
		"^/testapp": "/opt/sites/testapp/htdocs"
	}
}

```

Here are brief descriptions of the properties in the file.  More details are in the sections below.

| Property | Type | Description |
|----------|------|-------------|
| `name` | String | Every application needs a unique name, which is used for logging. |
| `pool` | String | This specifies which pool of workers to use for application requests. |
| `routes` | Object | Route one or more URI patters to handler scripts.  See [Routes](#routes) below. |
| `static` | Object | Route one or more URI patters to static files on disk.  See [Static Hosting](#static-hosting) below. |
| `acl` | Mixed | Optionally set an IP-based ACL ([Access Control Lists](#access-control-lists)) for the application (`false` allows all). |
| `headers` | Object | Optionally limit your application to requests that match certain headers.  See [Virtual Hosts](#virtual-hosts) below. |
| `pools` | Object | Optionally define additional custom worker pools.  See [Custom Pools](#custom-pools) below. |
| `log` | Object | Optionally define your own custom application log.  See [Custom Log](#custom-log) below. |

### Routes

Each application may define one or more "routes", which are URI patterns that map to custom Node.js script handlers.  The configuration syntax is an Object with keys set to the URI match patterns (regex as string), and the values set to filesystem paths to the scripts to handle requests.  Example:

```js
"routes": {
	"^/testapp/api": "/opt/sites/testapp/api.js",
	"^/something/upload": "/some/other/dir/upload.js"
}
```

This would route all requests that start with `/testapp/api` to the `/opt/sites/testapp/api.js` script, and those that start with `/something/upload` to the `/some/other/dir/upload.js` script.  Note that the URI matching is based on regular expressions, so you can use symbols such as `^` to denote the start of the string.

Note that you don't necessarily need to specify fully-qualified filesystem paths.  If your PoolNoodle configuration file is a symbolic link, then your script paths will be resolved relative to the original location of the config file.  So for example if your Node.js scripts and config file are in the same directory, and you symlink your config file into PoolNoodle, then you can reference your scripts like this:

```js
"routes": {
	"^/testapp/api": "api.js",
	"^/something/upload": "upload.js"
}
```

Your script files are watched for changes, and worker pools are automatically reloaded when needed.

For more advanced routing options, see the [Advanced Routing](#advanced-routing) section below.

### Scripts

Each of your routes points to a script, which is preloaded in applicable worker processes.  Your script is simply a Node.js module that exports certain methods for hooking operations (such as startup and handling a request).  Here is a very simple example:

```js
module.exports = {
	
	handler: function(args, callback) {
		// Send JSON response
		callback({
			code: 0,
			description: "Test app rocks!"
		});
	}
	
};
```

Here we are defining a module with a single method: `handler`.  This is a special function name, which PoolNoodle invokes for handling incoming requests that match your routes.  The function is passed an `args` object containing information about the request, and a callback to handle the response.

For more information about handling requests, sending responses and the `args` object, see the [Handling Requests](https://github.com/jhuckaby/pixl-server-pool#handling-requests) section in the [pixl-server-pool](https://github.com/jhuckaby/pixl-server-pool) module docs.

#### Script Methods

There are three methods with special names, that essentially register hooks to intercept certain actions.  They are `startup`, `handler` and `shutdown`.  Here is an example showing all of them:

```js
module.exports = {
	
	startup: function(callback) {
		callback();
	},
	
	handler: function(args, callback) {
		// Send JSON response
		callback({
			code: 0,
			description: "Test app rocks!"
		});
	},
	
	shutdown: function(callback) {
		callback();
	}
	
};
```

Here you can see all three methods implemented.  All of them pass a callback which must be fired when the operation is complete, with `handler` also passing an `args` object as the first argument.  For more information about handling requests, sending responses and the `args` object, see the [Handling Requests](https://github.com/jhuckaby/pixl-server-pool#handling-requests) section in the [pixl-server-pool](https://github.com/jhuckaby/pixl-server-pool) module docs.

Worker processes may be shut down and new ones started up at any time, and multiple workers may be active at once, depending on your pool configuration.  So it is important that you design your application code with this in mind.

#### Script Additions

When your script is first loaded, your `exports` object is augmented with a few additional methods and properties.  These are primarily for accessing your application's configuration, and providing methods for logging.  Here is a list of everything added to your `exports`:

| Property | Type | Description |
|----------|------|-------------|
| `__name` | String | A unique identifier for your script, used for logging.  This defaults to your app name and script filename, joined with a hyphen. |
| `config` | Object | A reference to your application's JSON configuration file, pre-parsed and in object form. |
| `serverConfig` | Object | A reference to the main PoolNoodle JSON configuration file, pre-parsed and in object form. |
| `logger` | Object | An instance of the [pixl-logger](https://github.com/jhuckaby/pixl-logger) class, used for logging purposes. |
| `debuglevel` | Integer | Debug logging level, used by the `logDebug()` method, set by the `worker_debug_level` configuration property. |
| `logDebug()` | Function | A convenience method provided to allow for easy debug logging (see [Script Logging](#script-logging). |
| `logError()` | Function | A convenience method provided to allow for easy error logging (see [Script Logging](#script-logging). |
| `logTransaction()` | Function | A convenience method provided to allow for easy transaction logging (see [Script Logging](#script-logging). |

#### Script Logging

Your script's `exports` object is augmented with three methods you can use to generate log messages.  By default, these will be appended to the PoolNoodle `Worker.log` file, with most columns automatically populated.  In most cases you only need to specify two columns, the code (or debug level), and a message.  Here is an example of a debug log message:

```js
this.logDebug(9, "Log message here!");
```

The first argument is the debug log level (verbosity), and the second is the message text.  Note that the log level has to be equal to or less than the `worker_debug_level` configuration property, for entries to be logged.

Similar to `logDebug()`, there is also `logError()`, which accepts the same arguments, but logs an error instead of a debug message.  The error code takes the place of the log level argument.  Example:

```js
this.logError(500, "An error occurred");
```

And finally, `logTransaction()` also accepts the same arguments, but logs a "transaction" rather than a debug message or error.  The only difference is really the `category` column, which is set to `transaction` in this case.  Example use:

```js
this.logTransaction(1234, "Money deposited into account");
```

You can optionally specify a 3rd argument to all three of these methods, which accepts any serializable object.  If provided, it is serialized to JSON and logged as the final `data` column.  Example:

```js
this.logDebug(9, "Log message here!", { foo: "bar", baz: 12345 });
```

This would produce a log entry like the following:

```
[TestApp-api.js][debug][9][Log message here!][{"foo":"bar","baz":12345}]
```

#### Custom Log

If you would prefer that your app logs to its own separate log file, PoolNoodle can facilitate this for you.  Simply define a `log` object in your app's configuration file, and fill it thusly:

```json
{
	"log": {
		"path": "/var/log/testapp.log",
		"level": 5
	}
}
```

This would log to the `/var/log/testapp.log` at debug level 5.  If not specified, the default set of log columns is defined as follows:

```json
["hires_epoch", "date", "hostname", "pid", "component", "category", "code", "msg", "data"]
```

Here are all the properties you can set in the `log` object:

| Property | Type | Description |
|----------|------|-------------|
| `path` | String | A fully-qualified filesystem path to the location of the log file.  The parent directories should already exist. |
| `level` | Number | The debug level for the log file, from `1` (quietest) to `9` (loudest).  If omitted, it will be set to the global `worker_debug_level` value. |
| `columns` | Array | Optionally customize the columns in the log. |
| `args` | Object | Optionally pass additional arguments to [pixl-logger](https://github.com/jhuckaby/pixl-logger).  See below for an example. |

Here is a more complete example with all properties specified:

```json
{
	"log": {
		"path": "/var/log/testapp.log",
		"level": 5,
		"columns": ["hires_epoch", "date", "hostname", "pid", "component", "category", "code", "msg", "data"],
		"args": {
			"sync": true
		}
	}
}
```

Using the `args` object, you can pass configuration settings (e.g. `sync`) to the logger.  See the [pixl-logger docs](https://github.com/jhuckaby/pixl-logger) for more details.

Note that PoolNoodle will still populate the `component` column for you, if you use the built-in script `logDebug()` method and family.

### Static Hosting

In addition to routing requests to custom Node.js scripts, you can also host static files in custom locations.  Static files are served from the parent (web server) process, and not routed to workers (for efficiency).  To set this up, declare a `static` object in your app's configuration file.  The object keys should be URI match patterns (regex strings), and the values should be base filesystem paths where your static files live.  Example:

```js
"static": {
	"^/testapp": "/opt/sites/testapp/htdocs"
}
```

This would route all requests that start with `/testapp` to the base directory `/opt/sites/testapp/htdocs`.  It will automatically serve up files in subdirectories as well, as well as guess the `Content-Type` based on the file extensions.  The [node-static](https://www.npmjs.com/package/node-static) module is ultimately used for this work.

Note that you don't necessarily need to specify fully-qualified filesystem paths.  If your PoolNoodle configuration file is a symbolic link, then your static base paths will be resolved relative to the original location of the config file.  So for example if your `htdocs` dir and config file are in the same directory, and you symlink your config file into PoolNoodle, then you can reference your static base path like this:

```js
"static": {
	"^/testapp": "htdocs"
}
```

See the [pixl-server-web](https://github.com/jhuckaby/pixl-server-web#configuration) documentation for details on configuring static hosting options, such as cache TTL (`Cache-Control` response header), default index document (`index.html`) and others.

Here is another potential use case for static hosting.  If your app includes any *client-side* dependencies like [jQuery](https://www.npmjs.com/package/jquery) or [Font Awesome](https://www.npmjs.com/package/font-awesome), you can use static hosting to setup routes to these files.  For example, let's say we include the following in our app's dependencies:

```js
"dependencies": {
	"jquery": "3.3.1",
	"font-awesome": "4.7.0"
}
```

The problem is, these libraries will be installed as Node modules, i.e. in your app's `node_modules/` folder, so they are not really "client-side accessible" by default.  You could create symlinks on install, but an easier way is to simply define static routes for them, like this:

```js
"static": {
	"^/testapp/lib/jquery": "node_modules/jquery/dist",
	"^/testapp/lib/font-awesome": "node_modules/font-awesome",
	"^/testapp": "htdocs"
}
```

**Important Note:** If you specify multiple static routes like this, make sure you list the more specific routes first, followed by the more generic catch-all route at the end.  In the above example we need the jQuery/FontAwesome routes to be matched *before* the generic `htdocs` route is evaluated (otherwise it would capture all static requests).

Then your client-side HTML code could import the libraries like this:

```html
<link rel="stylesheet" href="/testapp/lib/font-awesome/font-awesome.min.css">
<script src="/testapp/lib/jquery/jquery.min.js"></script>
```

Make sure you take a peek inside the NPM modules you download to see where they hide their client-side distribution files, e.g. pre-built files ready for HTML inclusion.

### Redirects

In addition to hosting APIs and local static files, you can also configure simple HTTP redirects.  These are actual external redirect responses (i.e. `HTTP 302`) sent back to the client.  To set this up, declare a `redirects` object in your app's configuration file.  The object keys should be URI match patterns (regex strings), and the values should be fully-qualified URLs.  Example:

```js
"redirects": {
	"^/testapp/google/(.+)": "https://www.google.com/search?q=$1",
	"^/testapp/bing/(.+)": "https://www.bing.com/search?q=$1"
}
```

As you can see in the above example, you can use regular expression groups in the URI match pattern, and expand them in the URL using `$1`, `$2`, etc.

The HTTP response code is `302 Found` by default.  To change this, see the [Advanced Routing](#advanced-routing) section below.

### Proxies

PoolNoodle has support for configuring proxies inside your applications.  A proxy will match certain URI patterns, and forward the requests to a secondary hostname and port, and handle passing the response back to the client.  To set this up, declare a `proxies` object in your app's configuration file.  The object keys should be URI match patterns (regex strings), and the values should be a target URL prefix (to which the request URI path is appended).  Example:

```js
"proxies": {
	"^/testapp/myproxy": "http://myserver.com:1234"
}
```

This would capture incoming requests that matched the `^/testapp/myproxy` URI pattern, and proxy them to the `http://myserver.com:1234` base URL.  Note that the original request URI path is appended to the proxy URL.  So for example, if a URL path came in like this:

```
/testapp/myproxy/foo
```

The downstream request URL would be:

```
http://myserver.com:1234/testapp/myproxy/foo
```

Lots of options are available for configuring how the proxy subrequests are made.  See [Advanced Routing](#advanced-routing) for more details on this.

### URL Rewrites

Sometimes you just need to remap (rewrite) one URL pattern to another on an incoming request.  This is also known as an "internal redirect".  This feature will match URI patterns, and remap (alter) the URL, then allow it to match other apps and routes.  URL rewrites are applied to requests very early, before a route and even before an app has been chosen.  To use these, declare a `rewrites` object in your app's configuration file.  The object keys should be URI match patterns (regex strings), and the values should be a URI path replacement.  Example:

```js
"rewrites": {
	"^/testapp/oldpath/(.+)": "/testapp/newpath/$1"
},
```

As you can see in the above example, you can use regular expression groups in the URI match pattern, and expand them in the URL using `$1`, `$2`, etc.

Instead of sending the client a hard redirect response (e.g. with [Redirects](#redirects)), these are *internally* redirected, by altering the incoming URI in place, then allowing the modified URI to be routed to other targets (and even other apps).  The client never sees the rewritten URL.

Multiple URL rewrites may be applied to the same URL on the same request, depending on how you have things configured.  There is also an emergency brake set at 32 rewrites allowed per request, to prevent infinite loops.

### Advanced Routing

PoolNoodle supports an alternate way of defining app routes, static hosting, redirects and proxies, that is more verbose and customizable.  The `routes` object in your app's configuration file can be an array of objects, with each object defining a route type and specific route options.  This also allows you to define a matching order, so certain routes can take precedence over others.  Here is an example:

```js
"routes": [
	{
		"type": "script",
		"uri_match": "^/testapp/api",
		"path": "api.js"
	},
	{
		"type": "redirect",
		"uri_match": "^/testapp/google/(.+)",
		"location": "https://www.google.com/search?q=$1"
	},
	{
		"type": "proxy",
		"uri_match": "^/testapp/proxythis",
		"target_protocol": "http:",
		"target_hostname": "myserver.com",
		"target_port": 1234
	},
	{
		"type": "static",
		"uri_match": "^/testapp",
		"path": "htdocs"
	}
],
```

The array is matched from top to bottom, so routes with higher priorities should be placed above the others.

Each route object should have a `type` property, which should be one of the following strings:

| Type | Description |
|------|-------------|
| `script` | An API route to a Node.js script.  See [Advanced API Routes](#advanced-api-routes). |
| `static` | A static host directory.  See [Advanced Static Hosting](#advanced-static-hosting). |
| `redirect` | A HTTP redirect configuration.  See [Advanced Redirects](#advanced-redirects). |
| `proxy` | A proxy configuration for forwarding HTTP requests.  See [Advanced Proxies](#advanced-proxies). |
| `rewrite` | A URL rewrite pattern and replacement.  See [Advanced URL Rewrites](#advanced-url-rewrites). |

See the following sections for details on each route type.

#### Advanced API Routes

Each application may define one or more API (i.e. script) routes, which are URI patterns that map to custom Node.js script handlers.  This is equivalent to the [Routes](#routes) shorthand definitions described above, but declaring routes in this way allows you specify extra parameters, and control the priority (matching order).  Here is an example:

```js
{
	"type": "script",
	"uri_match": "^/testapp/api",
	"path": "api.js"
}
```

Here are all the properties you can set for API routes:

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | **(Required)** This specifies the route type.  Set this to `script` for API routes. |
| `uri_match` | String | **(Required)** A regular expression pattern to match on the incoming URI path. |
| `path` | String | **(Required)** The destination Node.js script path to activate for API calls. |
| `acl` | Complex | Customize ACL for this route only.  Set to Boolean `true` or `false` (to override the app's default), or set it to an array of custom IP ranges.  See [Access Control Lists](#access-control-lists) for more. |

#### Advanced Static Hosting

In addition to routing requests to custom Node.js scripts, you can also host static files in custom locations.  Static files are served from the parent (web server) process, and not routed to workers (for efficiency).  This is equivalent to the [Static Hosting](#static-hosting) shorthand definitions described above, but declaring routes in this way allows you specify extra parameters, and control the priority (matching order).  Here is an example:

```js
{
	"type": "static",
	"uri_match": "^/testapp",
	"path": "htdocs"
}
```

Here are all the properties you can set for static hosting routes:

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | **(Required)** This specifies the route type.  Set this to `static` for static host routes. |
| `uri_match` | String | **(Required)** A regular expression pattern to match on the incoming URI path. |
| `path` | String | **(Required)** The destination directory filesystem path, housing the files to be statically served. |
| `acl` | Complex | Customize ACL for this route only.  Set to Boolean `true` or `false` (to override the app's default), or set it to an array of custom IP ranges.  See [Access Control Lists](#access-control-lists) for more. |

#### Advanced Redirects

In addition to hosting APIs and local static files, you can also configure simple HTTP redirects.  These are actual external redirect responses (i.e. `HTTP 302`) sent back to the client.  This is equivalent to the [Redirects](#redirects) shorthand definitions described above, but declaring routes in this way allows you specify extra parameters, and control the priority (matching order).  Here is an example:

```js
{
	"type": "redirect",
	"uri_match": "^/testapp/google/(.+)",
	"location": "https://www.google.com/search?q=$1"
}
```

Here are all the properties you can set for redirect routes:

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | **(Required)** This specifies the route type.  Set this to `redirect` for redirect routes. |
| `uri_match` | String | **(Required)** A regular expression pattern to match on the incoming URI path, which may contain regex groups. |
| `location` | String | **(Required)** The destination URL, which should be fully-qualified.  This may contain regex replacement macros (e.g. `$1`). |
| `encode` | Boolean | Set this to `true` to perform URL encoding on the regex replacement groups. |
| `status` | String | Use this to customize the HTTP response code and status line.  It defaults to `302 Found`. |
| `acl` | Complex | Customize ACL for this route only.  Set to Boolean `true` or `false` (to override the app's default), or set it to an array of custom IP ranges.  See [Access Control Lists](#access-control-lists) for more. |

#### Advanced Proxies

A proxy will match certain URI patterns, and forward the requests to a secondary hostname and port, and handle passing the response back to the client.  This is equivalent to the [Proxies](#proxies) shorthand definitions described above, but declaring routes in this way allows you specify extra parameters, and control the priority (matching order).  Here is an example:

```js
{
	"type": "proxy",
	"uri_match": "^/testapp/proxythis",
	"target_protocol": "http:",
	"target_hostname": "myserver.com",
	"target_port": 1234
},
```

Here are all the properties you can set for proxy routes:

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | **(Required)** This specifies the route type.  Set this to `proxy` for proxy routes. |
| `uri_match` | String | **(Required)** A regular expression pattern to match on the incoming URI path. |
| `target_hostname` | String | **(Required)** The target hostname for the downstream request. |
| `target_protocol` | String | The protocol to use for the downstream requests, e.g. `http:` or `https:`. Defaults to `http:`. |
| `target_port` | Number | The port to use for the downstream requests, e.g. `3000`.  Defaults to `80` for HTTP, or `443` for HTTPS. |
| `path_prefix` | String | Optional URI path prefix to insert into the downstream URLs. |
| `dir_index` | String | Optionally append a downstream filename to directory requests, e.g. `index.html`. |
| `use_keep_alives` | Boolean | This controls whether HTTP Keep-Alives are used or not.  Defaults to `true`. |
| `append_to_xff` | Boolean | This controls whether the client socket IP address is appended to the `X-Forwarded-For` header or not.  Defaults to `true`. |
| `preserve_host` | Boolean | This controls whether the client `Host` header is passed to the downstream service or not.  Defaults to `true`. |
| `insert_request_headers` | Object | Optionally insert custom request headers into the downstream service. |
| `insert_response_headers` | Object | Optionally insert custom response headers into the client response. |
| `scrub_request_headers` | String | Scrub (remove) special headers from the downstream request.  See below for details. |
| `scrub_response_headers` | String | Scrub (remove) special headers from the client response.  See below for details. |
| `acl` | Complex | Customize ACL for this route only.  Set to Boolean `true` or `false` (to override the app's default), or set it to an array of custom IP ranges.  See [Access Control Lists](#access-control-lists) for more. |

The `scrub_request_headers` and `scrub_response_headers` properties scrub (i.e. discard and do not forward) special headers from the downstream request and client response, respectively.  Both properties are formatted as regular expressions wrapped in strings, and they are matched case-insensitively.  Here are the default values:

```js
{
	"scrub_request_headers": "^(host|expect|content\\-length|connection)$",
	"scrub_response_headers": "^(connection|transfer\\-encoding)$"
}
```

The reason for scrubbing these headers it that they get either removed or replaced from one request to the other, so it is useless and often times an error to include them.  For example, the `Connection` header may differ between the client and back-end requests.

#### Advanced URL Rewrites

This feature will match URI patterns, and remap (alter) the URL *in place*, then allow it to target other apps and routes.  URL rewrites are applied to requests very early, before a route and even before an app has been chosen.  This is equivalent to the [URL Rewrites](#url-rewrites) shorthand definitions described above, but declaring routes in this way allows you control the priority (matching order).  Here is an example:

```js
{
	"type": "rewrite",
	"uri_match": "^/testapp/oldpath/(.+)",
	"uri_replace": "/testapp/newpath/$1"
}
```

Here are all the properties you can set for URL rewrites:

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | **(Required)** This specifies the route type.  Set this to `rewrite` for URL rewrites. |
| `uri_match` | String | **(Required)** A regular expression pattern to match on the incoming URI path. |
| `uri_replace` | String | **(Required)** The replacement URI path, which may contain regex macros (e.g. `$1`, `$2`, etc.) |

Multiple URL rewrites may be applied to the same URL on the same request, depending on how you have things configured.  There is also an emergency brake set at 32 rewrites allowed per request, to prevent infinite loops.

Note that you cannot customize the ACL for URL rewrites, as they are merely passthrough filters.  The ACL, if applicable, should be configured on the final target route (i.e. where the final rewritten URL points to).

### Virtual Hosts

All of the examples above use a URI-based match for routing.  You can also require that certain HTTP request headers match specific values, in order to route requests for your app.  The most commonly matched header is of course `host` (the hostname on the URL), to implement [name-based virtual hosting](https://en.wikipedia.org/wiki/Virtual_hosting#Name-based).  Consider this example:

```js
"headers": {
	"host": "^myapp\\.mycompany\\.com"
}
```

This is basically an extra rule that says the request `host` header (Node.js lower-cases these keys) must start with `myapp.mycompany.com` for the requests to be routed to the app.  Note that these particular regular expressions are matched case-insensitively, so `MYAPP.MYCOMPANY.COM` would also qualify.

Note that we aren't including the end-of-string (`$`) operator in the example regex above, because the `host` request header may contain a port number, e.g. `myapp.mycompany.com:3020`.

If you include multiple headers in the `headers` object, they *all* must match for the request to be considered for app routing.

### Custom Pools

You can define as many worker pools in the [main configuration](#pools), and simply reference them from your application configuration using the `pool` property.  However, there may be cases where you want your application to be able to define its own worker pools.  To do this, include a `pools` object in your app's config, and define a pool with a unique ID within.  Example:

```js
"pools": {
	"mycustom": {
		"min_children": 2,
		"max_children": 4
	}
}
```

Then you'd also want to set your app's `pool` property to `mycustom`, so your app routes use your custom pool:

```js
"pool": "mycustom"
```

### Access Control Lists

Some of your applications may require IP address based access restriction, known as an ACL or [Access Control List](https://en.wikipedia.org/wiki/Access_control_list).  There are two ways to activate this for your app.  First, if you set the `acl` property to `true`, your application will be restricted to the address blocks listed in the main [http_default_acl](https://github.com/jhuckaby/pixl-server-web#http_default_acl) property:

```js
"acl": true
```

Alternatively, if your application requires a custom set of IP address ranges to whitelist, you can specify your own custom ACL in the `acl` property, by setting it to an array of individual addresses or [CIDR blocks](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing):

```js
"acl": ["::1/128", "127.0.0.1/32", "169.254.0.0/16", "fe80::/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"]
```

Both IPv4 and IPv4 addresses and CIDR ranges are supported.  The example above includes all the [IPv4](https://en.wikipedia.org/wiki/Private_network#Private_IPv4_addresses) and [IPv6](https://en.wikipedia.org/wiki/Private_network#Private_IPv6_addresses) private address ranges, the [localhost loopback](https://en.wikipedia.org/wiki/Localhost#Loopback) addresses (both IPv4 and IPv6 versions), and the [link-local addresses](https://en.wikipedia.org/wiki/Link-local_address) (both IPv4 and IPv6 versions).

## Plugins

PoolNoodle supports Plugins, which can intercept and filter requests in the parent or worker processes.  To register a Plugin in the parent (web server) process to filter requests, specify the path in the `plugins` array in the main configuration.  Example:

```js
"plugins": [
	"/opt/sites/testapp/myplugin.js"
]
```

These Plugins are able to filter requests *very* early, including requests destined for application routes, and even static file requests.  Your Plugin code should be a Node.js script that exports the following functions (all are optional):

```js
module.exports = {
	
	startup: function(callback) {
		callback();
	},
	
	handler: function(args, callback) {
		// insert a custom request header
		args.request.headers['x-plugin'] = "A plugin inserted this!";
		
		// passthrough
		callback(false);
	},
	
	reload: function(callback) {
		callback();
	}
	
	shutdown: function(callback) {
		callback();
	}
	
};
```

In this example we are filtering every request and injecting a custom `x-plugin` request header.  All downstream Plugins and application route scripts will be able to see this.

In your `handler()` function, fire the callback with `false` to indicate that the request should pass through and continue being processed as per usual (i.e. route to app or static file).  However, you can also *intercept* (i.e. stop) the request and send back your own response.  To do this, simply fire the callback with any standard response compatible with [pixl-server-web](https://github.com/jhuckaby/pixl-server-web#sending-responses).  Example:

```js
callback( "200 OK", { "X-Foo": "Plugin" }, "Request was intercepted by Plugin!" );
```

It is important to note that parent Plugins filter requests so early that an application route has not yet been decided.  The request might not even be routed to an application (i.e. it may be a static file).  So keep this in mind when writing these types of Plugins.

Here are descriptions of the Plugin methods you can define, and what they do:

| Method | Description |
|--------|-------------|
| `startup()` | Called on initial server startup.  If defined, make sure you fire the `callback` to indicate completion.  Pass an `Error` object upon failure (which results in the entire PoolNoodle service shutting down). |
| `handler()` | Called for each request, very early in the request cycle.  Use this to filter requests before applications get them.  Fire the `callback` to passthrough or intercept request (see above). |
| `reload()` | Called when applications are being hot-reloaded. Useful if you implement application-specific features and may need to reinitialize them (new apps may have been added, etc.). |
| `shutdown()` | Called when the PoolNoodle service is shutting down.  Fire the `callback` when your Plugin is shut down and ready for the main process to exit. |

Your Plugin's `exports` object is augmented with the following properties and functions on startup:

| Property | Type | Description |
|----------|------|-------------|
| `__name` | String | A unique identifier for the Plugin, used for logging.  This defaults to your script filename. |
| `config` | Object | A reference to the main `conf/config.json` configuration file, pre-parsed and in object form. |
| `server` | Object | A reference to the [pixl-server](https://github.com/jhuckaby/pixl-server) class instance. |
| `web` | Object | A reference to the [pixl-server-web](https://github.com/jhuckaby/pixl-server-web) instance. |
| `apps` | Object | A reference to all of your application configurations, keyed by the app names. |
| `logger` | Object | An instance of the [pixl-logger](https://github.com/jhuckaby/pixl-logger) class, used for logging purposes. |
| `debuglevel` | Integer | Debug logging level, used by the `logDebug()` method, set by the `debug_level` configuration property. |
| `logDebug()` | Function | A convenience method provided to allow for easy debug logging (see [Logging](#logging). |
| `logError()` | Function | A convenience method provided to allow for easy error logging (see [Logging](#logging). |
| `logTransaction()` | Function | A convenience method provided to allow for easy transaction logging (see [Logging](#logging). |

Calling `logDebug()`, `logError()` or `logTransaction()` in Plugins causes an entry to be appended to the `Server.log` file.  The `component` column will be set to the `__name` property, which defaults to your script filename.

### Worker Plugins

Worker Plugins are a special type of Plugin that is loaded in each worker process, not the parent (web server) process.  These Plugins can still filter and intercept requests, but they fire a bit later in the request cycle, once an application route has been chosen and the request has been proxied to the worker.

To register a Plugin in the worker process to filter requests, specify the path in the `worker_plugins` array in the main configuration.  Example:

```js
"worker_plugins": [
	"/opt/sites/testapp/myworkerplugin.js"
]
```

Your Worker Plugin code should be a Node.js script that exports the following functions (all are optional):

```js
module.exports = {
	
	startup: function(callback) {
		callback();
	},
	
	handler: function(args, callback) {
		// filter request in worker
		
		// add a 100ms delay for all `testapp` app requests
		if (args.app == 'testapp') {
			setTimeout( function() { callback(false); }, 100 );
		}
		else {
			// immediate passthrough for other apps
			callback(false);
		}
	},
	
	shutdown: function(callback) {
		callback();
	}
	
};
```

Here we are filtering requests and intercepting those destined for the `testapp` application.  You'll notice that we can query the application name via the `args.app` property.  This will be preset to the chosen application to serve the route, so your Plugin can make filtering decisions based on that.  Note that all the loaded application configuration files are available in `this.apps`, and the app route scripts themselves in `this.scripts`.

Sending responses is different in the worker than in the parent.  For more information about sending responses and the `args` object, see the [Handling Requests](https://github.com/jhuckaby/pixl-server-pool#handling-requests) section in the [pixl-server-pool](https://github.com/jhuckaby/pixl-server-pool) module docs.

Here are descriptions of the Worker Plugin methods you can define, and what they do:

| Method | Description |
|--------|-------------|
| `startup()` | Called on each worker child startup.  If defined, make sure you fire the `callback` to indicate completion.  If you pass an `Error` object to the callback, the child will abort startup and die. |
| `handler()` | Called for each request, before the application handler is called.  Use this to filter requests.  Fire the `callback` to passthrough or intercept request (see above). |
| `shutdown()` | Called when the worker is shutting down (either for a hot reload or full PoolNoodle shutdown).  Fire the `callback` when your Plugin is ready for the worker to exit. |

You may notice that Worker Plugins do not implement a `reload()` method.  This is because when applications are reloaded, all worker processes are shut down, and new ones are spawned to take their place.

Your Worker Plugin's `exports` object is augmented with the following properties and functions on startup:

| Property | Type | Description |
|----------|------|-------------|
| `__name` | String | A unique identifier for the Plugin, used for logging.  This defaults to your script filename. |
| `config` | Object | A reference to the main `conf/config.json` configuration file, pre-parsed and in object form. |
| `apps` | Object | A reference to all of the application configurations that were loaded in the worker, keyed by the app names. |
| `scripts` | Object | A reference to all application route scripts that have been loaded in the worker, keyed by their file paths. |
| `logger` | Object | An instance of the [pixl-logger](https://github.com/jhuckaby/pixl-logger) class, used for logging purposes. |
| `debuglevel` | Integer | Debug logging level, used by the `logDebug()` method, set by the `worker_debug_level` configuration property. |
| `logDebug()` | Function | A convenience method provided to allow for easy debug logging (see [Logging](#logging). |
| `logError()` | Function | A convenience method provided to allow for easy error logging (see [Logging](#logging). |
| `logTransaction()` | Function | A convenience method provided to allow for easy transaction logging (see [Logging](#logging). |

Calling `logDebug()`, `logError()` or `logTransaction()` in Worker Plugins causes an entry to be appended to the `Worker.log` file.  The `component` column will be set to the `__name` property, which defaults to your script filename.

## Command-Line Usage

PoolNoodle comes with a simple command-line control script which is located here:

```
/opt/poolnoodle/bin/control.sh
```

It accepts a single command-line argument to start, stop, and a few other things.  Examples:

```
/opt/poolnoodle/bin/control.sh start
/opt/poolnoodle/bin/control.sh stop
/opt/poolnoodle/bin/control.sh restart
```

Here is the full command list:

| Command | Description |
|---------|-------------|
| `help` | Show usage information. |
| `start` | Start PoolNoodle as a background service. |
| `stop` | Stop PoolNoodle and wait until it actually exits. |
| `restart` | Calls stop, then start (hard restart). |
| `reload` | Requests a reload of all apps (rolling child restart). |
| `status` | Checks whether PoolNoodle is currently running. |
| `debug` | Start the service in debug mode (see [Debugging](#debugging) below). |
| `config` | Edit the main config file in your editor of choice (via `EDITOR` environment variable). |
| `showconfig` | Reveal the location of the main config file path on disk. |
| `boot` | Install PoolNoodle as a startup service (see [Server Reboot](#server-reboot) below). |
| `unboot` | Remove PoolNoodle from the startup services. |
| `upgrade` | Upgrades PoolNoodle to the latest stable release (or specify version). |

### Debugging

To start PoolNoodle in debug mode, issue this command:

```
/opt/poolnoodle/bin/debug.sh
```

This will start the service as a foreground process (not a daemon), and echo the worker event log straight to the console.  This is a great way to troubleshoot issues.  Hit Ctrl-C to exit.

Note that you may have to use `sudo` or become the root user to start the service, if your web server is listening on any port under 1,024 (i.e. port 80).

The `debug.sh` script actually overrides a variety of configuration parameters using command-line arguments.  This is the actual command it executes:

```
node --trace-warnings $HOMEDIR/lib/main.js --debug --debug_level 9 --echo --worker_echo --notify --PoolNoodle.pools.default.min_children 1 --PoolNoodle.pools.default.max_children 1 --WebServer.http_static_ttl 0 "$@"
```

Here is an explanation of the arguments:

| Argument | Description |
|----------|-------------|
| `--trace-warnings` | This prints stack traces for process warnings (including deprecations). See [--trace-warnings](https://nodejs.org/api/cli.html#cli_trace_warnings). |
| `$HOMEDIR/lib/main.js` | This is the path to the main executable script for PoolNoodle. |
| `--debug` | This enables debug mode in [pixl-server](https://github.com/jhuckaby/pixl-server) which causes the main process to run in the foreground (no daemon fork). |
| `--debug_level 9` | This sets the debug logging level to 9 (the loudest), so every debug message is logged. |
| `--echo` | This will echo the main PoolNoodle parent debug log to the console, so you can see the inner workings. |
| `--worker_echo` | This will echo the worker debug log to the console, so you can see your own application debug messages. |
| `--notify` | This enables desktop notifications for worker crashes, using the [node-notifier](https://www.npmjs.com/package/node-notifier) module. |
| `--PoolNoodle.pools.default.min_children 1` | Override the default worker pool to launch only 1 child process. |
| `--PoolNoodle.pools.default.max_children 1` | Override the default worker pool to launch only 1 child process. |
| `--WebServer.http_static_ttl 0` | Override the web server static hosting to disable caching. |
| `"$@"` | This passes along any command-line arguments to the `main.js` script. |

Feel free to edit these to taste.  But if you do, it is highly recommended you create your own shell script with a unique filename, so PoolNoodle upgrades won't clobber your changes.

### Server Reboot

If you want to have the PoolNoodle daemon start up automatically when your server reboots, use you can use the special `boot` command, which will register it with the operating system's startup service (i.e. [init.d](https://bash.cyberciti.biz/guide//etc/init.d) on Linux, [LaunchAgent](https://developer.apple.com/library/content/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) on macOS, etc.).  You only need to type this once:

```
sudo /opt/poolnoodle/bin/control.sh boot
```

To unregister and remove PoolNoodle from the server startup services, type this:

```
sudo /opt/poolnoodle/bin/control.sh unboot
```

See the [pixl-boot](https://github.com/jhuckaby/pixl-boot) module for more details on how this works.

### Upgrading

To upgrade PoolNoodle, you can use the built-in `upgrade` command:

```
/opt/poolnoodle/bin/control.sh upgrade
```

This will upgrade the app and all dependencies to the latest stable release, if a new one is available.  It will not affect your configuration settings.  Those will be preserved and imported to the new version.

Alternately, you can specify the exact version you want to upgrade (or downgrade) to:

```
/opt/poolnoodle/bin/control.sh upgrade 1.0.4
```

If you upgrade to the `HEAD` version, this will grab the very latest from GitHub.  Note that this is primarily for developers or beta-testers, and is likely going to contain bugs.  Use at your own risk:

```
/opt/poolnoodle/bin/control.sh upgrade HEAD
```

## Status Page

PoolNoodle comes with a built-in status page which you can access in your browser by hitting the `/status/` URI.  Note that it requires the user be inside the default ACL (see [http_default_acl](https://github.com/jhuckaby/pixl-server-web#http_default_acl)).  Here is a screenshot:

![Status Screenshot](https://pixlcore.com/software/poolnoodle/images/status-page.png)

The main overview section at the top of the page contains the following information:

- PoolNoodle Version
- Node.js Version
- Server Hostname
- Listening Ports
- LAN IP Address
- Main Process ID
- Total System Memory
- Number of CPUs
- Number of Pools
- Number of Apps
- Active Workers
- Open Sockets
- Platform / Arch
- Load Averages
- Total CPU Usage
- Total Memory Usage
- Process Uptime
- Server Uptime
- Total Requests Served
- Total Sockets Opened
- Current Bytes In/Sec
- Current Bytes Out/Sec
- Current Requests/Sec
- Average Request Time

Below that there are 3 main tables:

### Active Workers

The Active Workers table lists every worker process for every pool.  It has the following columns:

- Pool ID
- PID (Process ID)
- State
- Memory
- CPU %
- Uptime
- Requests Served
- Average Time
- Active Requests

### Open Sockets

The Open Sockets table lists every web server socket (TCP connection).  It has the following columns:

- ID
- State
- IP Address
- Protocol
- Requests Served
- Data Received
- Date Sent
- Uptime

### Recent Requests

The Recent Requests table lists the most recent 100 completed requests.  It has the following columns:

- App ID
- IP Address
- URL
- HTTP Response
- Data Received
- Data Sent
- Elapsed Time

### JSON Stats API

PoolNoodle keeps internal statistics on throughput and performance, which are exposed via a HTTP JSON REST service, configured by the [stats_uri_match](#stats_uri_match) property, which both enables the feature, and sets its URI endpoint.

Note that the [Status Page](#status-page) depends on this API endpoint being enabled, and set to `/stats/api` exactly.  If you change or disable this, the status page will no longer function.

If you hit the Stats API with any HTTP GET request, it'll emit stats in the response.  Add `?pretty=1` if you would like the JSON to be pretty-printed.  Example:

```js
{
	"version": "1.0.0",
	"process": {
		"pid": 27602,
		"ppid": 27596,
		"argv": [
			"/usr/local/bin/node",
			"/Users/jhuckaby/git/PoolNoodle/lib/main.js"
		],
		"execArgv": []
	},
	"system": {
		"node": "v10.9.0",
		"arch": "x64",
		"platform": "darwin",
		"totalMemoryBytes": 17179869184,
		"cores": 8,
		"uptime": 1107284,
		"load": [
			1.314453125,
			1.3466796875,
			1.25341796875
		]
	},
	"totals": {
		"requests": 0,
		"sockets": 1,
		"elapsed_ms": 0
	},
	"cpu": {
		"pct": 0.05494
	},
	"mem": {
		"rss": 35024896,
		"heapTotal": 19644416,
		"heapUsed": 10878528,
		"external": 315747
	},
	"web": {
		"server": {
			"uptime_sec": 18,
			"hostname": "joedark.local",
			"ip": "192.168.3.23",
			"name": "PoolNoodle",
			"version": "1.0.0",
			"ports": [
				3020
			]
		},
		"stats": {
			"num_requests": 0,
			"bytes_in": 0,
			"bytes_out": 0,
			"total": {
				"st": "mma",
				"min": 0,
				"max": 0,
				"total": 0,
				"count": 0,
				"avg": 0
			},
			"read": {
				"st": "mma",
				"min": 0,
				"max": 0,
				"total": 0,
				"count": 0,
				"avg": 0
			},
			"process": {
				"st": "mma",
				"min": 0,
				"max": 0,
				"total": 0,
				"count": 0,
				"avg": 0
			},
			"write": {
				"st": "mma",
				"min": 0,
				"max": 0,
				"total": 0,
				"count": 0,
				"avg": 0
			}
		},
		"sockets": {
			"c1": {
				"state": "processing",
				"ip": "::1",
				"proto": "http",
				"port": 3020,
				"uptime_ms": 8,
				"num_requests": 0,
				"bytes_in": 0,
				"bytes_out": 0,
				"ips": [
					"::1"
				],
				"method": "GET",
				"uri": "/status/api?pretty=1",
				"host": "LOCALHOST:3020",
				"elapsed_ms": 1.647889
			}
		},
		"recent": []
	},
	"apps": {
		"TestApp": {
			"name": "TestApp",
			"pool": "default",
			"acl": true,
			"routes": {
				"^/testapp/api": "api.js"
			},
			"static": {
				"^/testapp": "htdocs"
			},
			"file": "/Users/jhuckaby/Sites/testapp/testapp.json",
			"dir": "/Users/jhuckaby/Sites/testapp"
		}
	},
	"pools": {
		"default": {
			"startup": 0,
			"active": 1,
			"maint": 0,
			"shutdown": 0
		}
	},
	"workers": [
		{
			"pid": "27603",
			"pool_id": "default",
			"state": "active",
			"num_active_requests": 0,
			"stats": {
				"start_time": 1542578227.614,
				"num_requests": 0,
				"total_elapsed_ms": 0,
				"cpu": {
					"pct": 0.0184
				},
				"mem": {
					"rss": 30072832,
					"heapTotal": 12828672,
					"heapUsed": 7325696,
					"external": 94919
				}
			}
		}
	]
}
```

The JSON Stats API is protected by an ACL, so only "internal" requests can access it.  This is accomplished by using the ACL feature in the web server, for the stats API endpoint.  By default, the ACL is restricted to localhost, plus the [IPv4 private reserved space](https://en.wikipedia.org/wiki/Private_network) and [IPv6 private reserved space](https://en.wikipedia.org/wiki/Private_network#Private_IPv6_addresses), but you can customize it by including a [http_default_acl](https://github.com/jhuckaby/pixl-server-web#http_default_acl) property in your `WebServer` configuration.  Please see the [pixl-server-web ACL](https://github.com/jhuckaby/pixl-server-web#access-control-lists) documentation for more details on this.

#### Web Server Stats

The PoolNoodle Stats API also includes stats from the web server, which will be in the `web` object.  Here is an example of what that looks like:

```js
"web": {
	"server": {
		"uptime_sec": 91,
		"hostname": "joedark.local",
		"ip": "192.168.3.20",
		"name": "PoolNoodle",
		"version": "1.0.0"
	},
	"stats": {
		"total": {
			"st": "mma",
			"min": 1.088,
			"max": 25.037,
			"total": 590.802,
			"count": 368,
			"avg": 1.605
		},
		"read": {
			"st": "mma",
			"min": 0.003,
			"max": 0.012,
			"total": 1.287,
			"count": 368,
			"avg": 0.003
		},
		"process": {
			"st": "mma",
			"min": 0.829,
			"max": 24.602,
			"total": 460.795,
			"count": 368,
			"avg": 1.252
		},
		"write": {
			"st": "mma",
			"min": 0.205,
			"max": 19.688,
			"total": 125.003,
			"count": 368,
			"avg": 0.339
		},
		"bytes_in": 105248,
		"bytes_out": 99728,
		"num_requests": 368,
		"cur_sockets": 2
	},
	"sockets": {
		"c3001": {
			"state": "processing",
			"ip": "::ffff:127.0.0.1",
			"proto": "http",
			"port": 3020,
			"elapsed_ms": 0.212232,
			"num_requests": 6,
			"bytes_in": 3132,
			"bytes_out": 50911,
			"ips": [
				"::ffff:127.0.0.1"
			],
			"method": "GET",
			"uri": "/stats/api?pretty=1",
			"host": "127.0.0.1:3020"
		},
		"c11952": {
			"state": "idle",
			"ip": "::ffff:127.0.0.1",
			"proto": "http",
			"port": 3020,
			"elapsed_ms": 0,
			"num_requests": 0,
			"bytes_in": 0,
			"bytes_out": 0
		}
	},
	"recent": []
}
```

Please see the [pixl-server-web stats](https://github.com/jhuckaby/pixl-server-web#stats) documentation for more details on this data.

# Logging

PoolNoodle uses the logging system built into [pixl-server](https://github.com/jhuckaby/pixl-server#logging), however we use two different logs: `Server.log` and `Worker.log`.   One is used by the main parent (web server) process, and the other is used by all pool worker processes.  Both are combined "event logs" which contain debug messages, errors and transactions, denoted by a `category` column.  By default, the log columns are defined as:

```javascript
['hires_epoch', 'date', 'hostname', 'pid', 'component', 'category', 'code', 'msg', 'data']
```

The general logging configuration is controlled by these top-level properties:

| Property Name | Type | Description |
|---------------|------|-------------|
| `log_dir` | String | Directory path where event log will be stored.  Can be a fully-qualified path, or relative from the PoolNoodle base directory. |
| `log_filename` | String | Server log filename, joined with `log_dir`. |
| `worker_log_filename` | String | Worker log filename, joined with `log_dir`. |
| `debug_level` | Integer | Debug logging level for the server process, larger numbers are more verbose, 1 is quietest, 9 is loudest. |
| `worker_debug_level` | Integer | Debug logging level for workers, larger numbers are more verbose, 1 is quietest, 9 is loudest. |

## Debug Log

Log entries with the `category` set to `debug` are debug messages, and have a verbosity level from 1 to 9.

Here is an example `Server.log` excerpt showing a typical startup.  In all these log examples the first 4 columns (`hires_epoch`, `date`, `hostname` and `pid`) are omitted for display purposes.  The columns shown are `component`, `category`, `code`, `msg`, and `data`.

```
[PoolNoodle][debug][1][PoolNoodle v1.0.0 Starting Up][{"pid":27766,"ppid":27760,"node":"v10.9.0","arch":"x64","platform":"darwin","argv":["/usr/local/bin/node","/Users/jhuckaby/git/PoolNoodle/lib/main.js","--debug","--debug_level","9","--worker_echo","--color","--notify","--PoolNoodle.pools.default.min_children","1","--PoolNoodle.pools.default.max_children","1","--WebServer.http_static_ttl","0"],"execArgv":["--trace-warnings"]}]
[PoolNoodle][debug][9][Writing PID File: logs/pid.txt: 27766][]
[PoolNoodle][debug][9][Confirmed PID File contents: logs/pid.txt: 27766][]
[PoolNoodle][debug][2][Server IP: 192.168.3.23, Daemon PID: 27766][]
[PoolNoodle][debug][3][Starting component: WebServer][]
[WebServer][debug][2][pixl-server-web v1.1.10 starting up][]
[WebServer][debug][2][Starting HTTP server on port: 3020][]
[PoolNoodle][debug][3][Starting component: PoolManager][]
[PoolManager][debug][3][pixl-server-pool v1.0.8 starting up][]
[PoolNoodle][debug][3][Starting component: PoolNoodle][]
[PoolNoodle][debug][3][PoolNoodle engine v1.0.0 starting up][]
[WebServer][debug][3][Adding custom URI handler: /^\/status\/api/: PoolNoodle Stats][]
[WebServer][debug][3][Adding custom URI handler: /.+/: PoolNoodle][]
[PoolNoodle][debug][3][Reloading all apps][]
[PoolNoodle][debug][9][Loading app config file: /Users/jhuckaby/Sites/testapp/testapp.json][]
[PoolNoodle][debug][9][App route added for TestApp: ^/testapp/api][{"pool":"default","acl":false,"script":"/Users/jhuckaby/Sites/testapp/api.js"}]
[PoolNoodle][debug][9][Static route added for TestApp: ^/testapp][{"pool":"default","acl":false,"path":"/Users/jhuckaby/Sites/testapp/htdocs"}]
[PoolNoodle][debug][3][Adding pool: default][{"min_children":1,"max_children":1,"max_concurrent_requests":0,"max_requests_per_child":0,"max_concurrent_launches":1,"max_concurrent_maint":1,"child_headroom_pct":0,"child_busy_factor":1,"startup_timeout_sec":10,"shutdown_timeout_sec":10,"request_timeout_sec":0,"maint_timeout_sec":0,"auto_maint":false,"script":"lib/worker.js"}]
[Pool-default][debug][2][Starting up pool][]
[Pool-default][debug][4][Worker starting up][]
[Pool-default][debug][4][Spawned new child process: 27767][{"cmd":"/usr/local/bin/node","args":["--trace-warnings","/Users/jhuckaby/node_modules/pixl-server-pool/worker.js","--debug","--debug_level","9","--worker_echo","--color","--notify","--PoolNoodle.pools.default.min_children","1","--PoolNoodle.pools.default.max_children","1","--WebServer.http_static_ttl","0"],"script":"lib/worker.js"}]
[Pool-default][debug][5][Current worker states][{"startup":1}]
[Pool-default][debug][5][Worker 27767 startup complete, ready to serve][]
[Pool-default][debug][5][Worker 27767 changing state from 'startup' to 'active'][]
[Pool-default][debug][5][Current worker states][{"active":1}]
[Pool-default][debug][2][Pool startup complete][]
[PoolNoodle][debug][4][Loading plugin: /Users/jhuckaby/Sites/testapp/myplugin.js][]
[PoolNoodle][debug][2][Startup complete, entering main loop][]
```

And here is what startup looks like in `Worker.log` (repeated for each worker process):

```
[NoodleWorker][debug][2][NoodleWorker v1.0.0 Starting Up][{"pid":27767,"ppid":27766,"node":"v10.9.0","arch":"x64","platform":"darwin","argv":["/usr/local/bin/node","/Users/jhuckaby/node_modules/pixl-server-pool/worker.js","--debug","--debug_level","9","--worker_echo","--color","--notify","--PoolNoodle.pools.default.min_children","1","--PoolNoodle.pools.default.max_children","1","--WebServer.http_static_ttl","0"],"execArgv":["--trace-warnings"]}]
[NoodleWorker][debug][3][Loading app: TestApp][{"name":"TestApp","pool":"default","acl":false,"headers":{"host":"^.+$"},"routes":{"^/testapp/api":"api.js"},"static":{"^/testapp":"htdocs"},"file":"/Users/jhuckaby/Sites/testapp/testapp.json","dir":"/Users/jhuckaby/Sites/testapp"}]
[NoodleWorker][debug][4][Loading TestApp script: /Users/jhuckaby/Sites/testapp/api.js][]
[NoodleWorker][debug][3][Starting up script: /Users/jhuckaby/Sites/testapp/api.js][]
[TestApp-api.js][debug][9][testapp starting up!][]
[NoodleWorker][debug][4][Loading worker plugin: /Users/jhuckaby/Sites/testapp/myworkerplugin.js][]
[NoodleWorker][debug][2][Startup complete][]
```

Here are all the debug entries in `Worker.log` for an application request (with the debug level set to 9):

```
[NoodleWorker][debug][9][Sending request: http://LOCALHOST:3020/testapp/api?foo=bar to TestApp: /Users/jhuckaby/Sites/testapp/api.js][{"headers":{"host":"LOCALHOST:3020","user-agent":"curl/7.54.0","accept":"*/*","x-plugin":"myplugin.js inserted this!","x-app":"TestApp"},"ips":["::1"]}]
[TestApp-api.js][debug][9][testapp handling request! http://LOCALHOST:3020/testapp/api?foo=bar][]
[NoodleWorker][debug][9][Sending JSON response][{"code":0,"description":"testapp rocks!"}]
```

And here is the shutdown sequence (in `Worker.log`):

```
[NoodleWorker][debug][3][Shutting down script: /Users/jhuckaby/Sites/testapp/api.js][]
[TestApp-api.js][debug][9][testapp shutting down!][]
[NoodleWorker][debug][2][Shutdown complete][]
```

And here is shutdown in the main `Server.log`:

```
[PoolNoodle][debug][1][Caught SIGINT][]
[PoolNoodle][debug][1][Shutting down][]
[PoolNoodle][debug][9][Deleting PID File: logs/pid.txt: 27766][]
[PoolNoodle][debug][3][Stopping component: PoolNoodle][]
[PoolNoodle][debug][3][Shutting down PoolNoodle][]
[PoolNoodle][debug][2][Shutdown complete][]
[PoolNoodle][debug][3][Stopping component: PoolManager][]
[PoolManager][debug][3][Worker Pool Manager shutting down][]
[Pool-default][debug][2][Shutting down pool: default][]
[Pool-default][debug][4][Worker 27767 shutting down (1 requests served)][]
[Pool-default][debug][6][Sending 'shutdown' command to process: 27767][]
[Pool-default][debug][5][Worker 27767 changing state from 'active' to 'shutdown'][]
[Pool-default][debug][5][Current worker states][{"shutdown":1}]
[Pool-default][debug][4][Child 27767 exited with code: 0][]
[Pool-default][debug][4][Worker 27767 has been removed from the pool][]
[Pool-default][debug][2][All workers exited, pool shutdown complete][]
[PoolNoodle][debug][3][Stopping component: WebServer][]
[WebServer][debug][2][Shutting down HTTP server][]
[PoolNoodle][debug][2][Shutdown complete, exiting][]
[WebServer][debug][3][HTTP server has shut down.][]
```

## Error Log

Errors can be logged for a variety of reasons, and will have the `component` log column set to `error`.  An example includes an HTTP error response such as a 404 (file not found):

```
[WebServer][error][404][Error serving static file: /Ztestapp/api?foo=bar: HTTP 404 Not Found][{"ips":["::1"],"useragent":"curl/7.54.0","referrer":"","cookie":"","url":"http://LOCALHOST:3020/Ztestapp/api?foo=bar"}]
```

These are logged to the main `Server.log` file.

## Transaction Log

A transaction is a completed back-end HTTP request, and is denoted by the `category` column set to `transaction`.  These are only logged if explicitly enabled via the [http_log_requests](https://github.com/jhuckaby/pixl-server-web#http_log_requests) web server configuration property.  Here is an example transaction:

```
[WebServer][transaction][HTTP 200 OK][/testapp/api?foo=bar][{"proto":"http","ips":["::1"],"host":"LOCALHOST:3020","ua":"curl/7.54.0","perf":{"scale":1000,"perf":{"total":119.681,"read":1.835,"process":112.487,"myplugin.js":0.362,"route":0.249,"worker":109.888,"myworkerplugin.js":101.215,"TestApp":0.613,"write":4.052},"counters":{"bytes_in":97,"bytes_out":137,"num_requests":1},"app_id":"TestApp"}}]
```

These are logged to the main `Server.log` file.

## Log Archives

Every night at midnight (local server time), the logs can be archived (gzipped) to a separate location.  The `log_archive_path` configuration parameter specifies the path, and the directory naming / filenaming convention of the archive files.  It can utilize date placeholders including `[yyyy]`, `[mm]` and `[dd]`.

This can be a partial path, relative to the PoolNoodle base directory (`/opt/poolnoodle`) or a full path to a custom location.  It defaults to `logs/archives/[yyyy]/[mm]/[dd]/[filename]-[yyyy]-[mm]-[dd].log.gz`.

# License

**The MIT License (MIT)**

*Copyright (c) 2018 - 2021 by Joseph Huckaby.*

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
