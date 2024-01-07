// PoolNoodle Proxy Mix-In
// Copyright (c) 2021 Joseph Huckaby
// Released under the MIT License

const http = require('http');
const Class = require("class-plus");
const Tools = require("pixl-tools");
const Request = require("pixl-request");
const StreamMeter = require("stream-meter");
const noop = function() {};

module.exports = Class({
	
},
class NoodleProxy {
	
	handle_proxy(args, route, callback) {
		// proxy request to specified target
		// target_protocol, target_hostname, target_port, path_prefix, use_keep_alives, append_to_xff, preserve_host, 
		// insert_request_headers, insert_response_headers, scrub_request_headers, scrub_response_headers
		var self = this;
		var request = args.request;
		
		if (!route.agent) {
			// initial setup for route
			if (!("use_keep_alives" in route)) route.use_keep_alives = true;
			if (!("append_to_xff" in route)) route.append_to_xff = true;
			if (!("preserve_host" in route)) route.preserve_host = true;
			
			route.agent = new http.Agent({
				keepAlive: !!route.use_keep_alives
			});
			
			if (!route.target_protocol) route.target_protocol = 'http:';
			if (!route.scrub_request_headers) {
				route.scrub_request_headers = "^(host|expect|content\\-length|connection)$";
			}
			if (!route.scrub_response_headers) {
				route.scrub_response_headers = "^(connection|transfer\\-encoding)$";
			}
			if (typeof(route.scrub_request_headers) == 'string') {
				route.scrub_request_headers = new RegExp(route.scrub_request_headers, 'i');
			}
			if (typeof(route.scrub_response_headers) == 'string') {
				route.scrub_response_headers = new RegExp(route.scrub_response_headers, 'i');
			}
			
			// setup request object
			route.request = new Request();
			route.request.setUserAgent( route.http_user_agent || '' );
			route.request.setTimeout( route.http_timeout_ms || 30000 );
			route.request.setFollow( route.follow_redirects || 0 );
			route.request.setDNSCache( route.cache_dns_sec || 0 );
			
			// prevent default Accept-Encoding header
			route.request.defaultHeaders = {};
			
			// do not auto-decompress responses (we want pure passthrough)
			route.request.setAutoDecompress( false );
			
			route.url_prefix = route.target_protocol + '//' + route.target_hostname;
			if (route.target_port) {
				if ((route.target_protocol == 'http:') && (route.target_port != 80)) {
					route.url_prefix += ':' + route.target_port;
				}
				else if ((route.target_protocol == 'https:') && (route.target_port != 443)) {
					route.url_prefix += ':' + route.target_port;
				}
			}
			if (route.path_prefix && (route.path_prefix != '/')) {
				route.url_prefix += route.path_prefix;
			}
		} // setup
		
		// execute request
		var url = route.url_prefix + request.url;
		
		// append dir_index in special circumstances (i.e. S3 static proxy)
		if (route.dir_index && url.match(/\/$/)) {
			url += route.dir_index;
		}
		
		// process incoming raw headers into hash, preserve mixed case
		var raw_headers = {};
		for (var idx = 0, len = request.rawHeaders.length; idx < len; idx += 2) {
			var key = request.rawHeaders[idx];
			var value = request.rawHeaders[idx + 1];
			if (!key.match( route.scrub_request_headers )) {
				raw_headers[ key ] = request.headers[key.toLowerCase()] || value;
			}
		}
		
		// if front-end request was HTTPS, pass along a hint
		if (request.headers.ssl) raw_headers['X-Forwarded-Proto'] = 'https';
		
		// setup pixl-request options
		var opts = {
			method: request.method,
			agent: route.agent,
			headers: Tools.mergeHashes( raw_headers, route.insert_request_headers || {} )
		};
		
		// optionally augment X-Forwarded-For, like a good proxy should
		if (route.append_to_xff) {
			if (request.headers['x-forwarded-for']) opts.headers['X-Forwarded-For'] = request.headers['x-forwarded-for'] + ', ';
			else opts.headers['X-Forwarded-For'] = '';
			
			var ip = request.socket.remoteAddress;
			if (ip.match(/(\d+\.\d+\.\d+\.\d+)/)) ip = RegExp.$1; // extract IPv4
			
			opts.headers['X-Forwarded-For'] += ip;
			delete opts.headers['x-forwarded-for']; // just in case
		}
		
		// optionally pass along host header
		if (route.preserve_host && request.headers['host']) {
			opts.headers['Host'] = request.headers['host'];
		}
		
		// handle binary data / files or other
		var req_func = 'request';
		
		if (opts.method == 'POST') {
			// HTTP POST
			// preserve post parameters and/or file uploads
			req_func = 'post';
			
			if (request.headers['content-type']) {
				// normalize content-type, as it's rather special
				for (var key in opts.headers) {
					if (key.match(/^(content-type)$/i)) delete opts.headers[key];
				}
				opts.headers['Content-Type'] = request.headers['content-type'];
			}
			
			if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'multipart/form-data';
			opts.headers['Content-Type'] = opts.headers['Content-Type'].replace(/\;.+$/, '');
			delete opts.headers['content-type']; // just in case
			
			switch (opts.headers['Content-Type']) {
				case 'multipart/form-data':
					var files = args.files;
					opts.data = Tools.copyHashRemoveKeys(args.params, files);
					
					opts.files = {};
					for (var key in files) {
						var file = files[key];
						opts.files[key] = [ file.path, file.name ];
					}
				break;
				
				case 'application/x-www-form-urlencoded':
					opts.data = args.params;
				break;
				
				case 'application/json':
				case 'application/javascript':
				case 'text/json':
				case 'text/javascript':
					opts.data = JSON.stringify(args.params);
				break;
				
				default:
					if (args.params.raw) opts.data = args.params.raw;
				break;
			} // switch content-type
		}
		else {
			// HTTP GET or other
			if (args.params.raw) opts.data = args.params.raw;
		}
		
		this.logDebug(8, "Proxying " + request.method + " request: " + url, opts.headers);
		
		// prepare streaming response
		var callback_fired = false;
		
		if (opts.method != 'HEAD') {
			opts.download = new StreamMeter();
			opts.pre_download = function(err, resp, stream) {
				// fired after response headers but before data
				if (args.request.socket.destroyed) {
					self.logDebug(9, "Detected destroyed socket, aborting streaming response");
					return false; // abort stream
				}
				
				// prepare streaming response, start one end of stream
				resp.pipe( stream );
				
				// ignore stream errors (prevent crash on socket close)
				resp.on('error', noop);
				stream.on('error', noop);
				
				// preserve raw response headers
				var raw_headers = {};
				for (var idx = 0, len = resp.rawHeaders.length; idx < len; idx += 2) {
					var key = resp.rawHeaders[idx];
					var value = resp.rawHeaders[idx + 1];
					if (!key.match( route.scrub_response_headers )) {
						raw_headers[ key ] = resp.headers[key.toLowerCase()] || value;
					}
				}
				
				self.logDebug(9, "Streaming response back to client: " + resp.statusCode + ' ' + resp.statusMessage, raw_headers);
				
				// fire callback with stream, which starts the other end
				callback_fired = true;
				args.perf.end('route');
				callback(
					'' + resp.statusCode + ' ' + resp.statusMessage,
					Tools.mergeHashes( raw_headers, route.insert_response_headers || {} ),
					stream
				);
				
				return true; // stream handled
			}; // pre_download
		} // not HEAD
		
		// actually send request now
		route.request[req_func]( url, opts, function(err, resp, data, perf) {
			// request complete
			// if we had a hard error, mock up a HTTP response for it
			if (err && !resp) {
				resp = {
					statusCode: 500,
					statusMessage: "Internal Server Error",
					rawHeaders: [],
					headers: {}
				};
				data = err.toString();
			}
			
			// downstream proxy request completed
			var metrics = perf ? perf.metrics() : {};
			
			self.logDebug(8, "Proxy request completed: HTTP " + resp.statusCode + " " + resp.statusMessage, {
				resp_headers: resp.headers,
				perf_metrics: metrics
			});
			
			if (err) {
				self.logError( resp.statusCode, "Proxy Request Error: HTTP " + resp.statusCode + " " + resp.statusMessage + ": " + data, {
					url: url,
					method: request.method,
					req_headers: request.headers,
					http_code: resp.statusCode,
					http_message: resp.statusMessage,
					resp_headers: resp.headers,
					perf_metrics: metrics,
					error_details: data.toString()
				} );
			}
			
			// import perf metrics, if available
			if (perf) args.perf.import( metrics );
			
			// send response to client (if not in blind mode)
			if (!callback_fired) {
				// preserve raw response headers
				var raw_headers = {};
				for (var idx = 0, len = resp.rawHeaders.length; idx < len; idx += 2) {
					var key = resp.rawHeaders[idx];
					var value = resp.rawHeaders[idx + 1];
					if (!key.match( route.scrub_response_headers )) {
						raw_headers[ key ] = resp.headers[key.toLowerCase()] || value;
					}
				}
				
				callback_fired = true;
				args.perf.end('route');
				callback(
					'' + resp.statusCode + ' ' + resp.statusMessage,
					Tools.mergeHashes( raw_headers, route.insert_response_headers || {} ),
					data
				);
			} // callback not fired
			
		} ); // request
	}
	
});
