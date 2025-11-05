// PoolNoodle App Installer
// Copyright (c) 2025 Joseph Huckaby, MIT License.
// https://github.com/jhuckaby/PoolNoodle

// Installs any PoolNoodle app hosted on NPM or GitHub:
//   noodle install my-noodle-app@1.0.0
//   noodle install github:jhuckaby/sample-noodle#v1.0.5

const Path = require('path');
const fs = require('fs');
const util = require('util');
const os = require('os');
const cp = require('child_process');
const Tools = require('pixl-tools');

const base_dir = '/opt/poolnoodle';
const app_base_dir = base_dir + '/apps';

const usage = `Usage: noodle install my-noodle-app@1.0.0`;

function die(msg) {
	console.error( "\nERROR: " + msg + "\n");
	process.exit(1);
}

const npm_bin = Tools.findBinSync('npm');
if (!npm_bin) die("Could not find NPM binary.");

var app_str = process.argv[3];
if (!app_str) die(usage);

// Special GitHub shortcut for #latest tag
if (app_str.match(/^github:([\w\-\.\/]+)\#latest$/)) {
	var gh_org_repo = RegExp.$1;
	var curl_bin = Tools.findBinSync('curl');
	if (!curl_bin) die("Could not find curl binary.");
	var gh_cmd = `${curl_bin} -s https://api.github.com/repos/${gh_org_repo}/tags | grep '"name":' | head -1 | cut -d'"' -f4`;
	try {
		var tag_name = cp.execSync( gh_cmd, { encoding: 'utf8' } ).trim();
		app_str = app_str.replace( /\#latest$/, '#' + tag_name );
	}
	catch (err) {
		die("Failed to query git for latest tag: " + err);
	}
}

const app_name = app_str.replace(/^\@[\w\-]+\//, '').replace(/[\@\#].+$/, '').replace(/^\w+\:[\w\-\.]+\//, '');
const app_hash = Tools.digestHex( app_str, 'sha256', 16 );
const app_hash_dir = app_base_dir + '/versions/' + app_hash;
const app_dir = app_base_dir + '/' + app_name;

const app = {
	
	find() {
		// find hashed location of specified app+version
		console.log("");
		
		if (!fs.existsSync(app_hash_dir)) {
			console.error( `NOT INSTALLED: ${app_str}` );
			console.error( `Path Not Found: ${app_hash_dir}` );
			process.exit(1);
		}
		
		console.log( app_str + " is installed:\n" + app_hash_dir + `/node_modules/${app_name}` );
		
		// is it active too?
		if (!fs.existsSync(app_dir)) {
			console.log( `${app_name} is not active at all (any version).` );
			process.exit(0);
		}
		
		var target = Path.resolve( fs.readlinkSync(app_dir) );
		if (target.includes(app_hash_dir)) {
			console.log( `Version is currently active.` );
		}
		else {
			console.log( `Version is NOT active.` );
			var pkg = JSON.parse( fs.readFileSync(target + `/package.json`, 'utf8') );
			console.log( `(Current active version is: ${pkg.version})` );
		}
		
		console.log("");
	},
	
	install() {
		// install app
		if (fs.existsSync(app_hash_dir)) {
			// selected version already exists, so just activate it
			console.log( `${app_str} is already downloaded.` );
			return this.activate();
		}
		
		console.log(`Installing: ${app_str}...`);
		
		// create dir
		Tools.mkdirp.sync( app_hash_dir, 0o775 );
		
		// write minimal package json into dir
		var pkg = { dependencies: {}, _poolnoodle: { app_name, app_str, app_hash } };
		pkg.dependencies[app_name] = app_str;
		fs.writeFileSync( app_hash_dir + '/package.json', JSON.stringify(pkg, null, "\t") + "\n" );
		
		// call npm to install it
		try {
			cp.execSync( npm_bin + ' install', { cwd: app_hash_dir, stdio: 'inherit' } );
		}
		catch (err) {
			die("Failed to NPM install: " + err);
		}
		
		console.log("Installed to: " + app_hash_dir);
		
		// activate app
		this.activate();
	},
	
	symlink(source, target) {
		// create symlink, replacing target if exists, also auto-create parent dirs
		if (fs.existsSync(target)) fs.unlinkSync(target);
		else if (!fs.existsSync( Path.dirname(target) )) Tools.mkdirp.sync( Path.dirname(target), 0o775 );
		fs.symlinkSync( source, target );
	},
	
	activate() {
		// activate app
		console.log("Activating app: " + app_str);
		
		if (fs.existsSync(app_dir)) {
			// some version is already active, check against one user is trying to activate
			var target = Path.resolve( fs.readlinkSync(app_dir) );
			if (target.includes(app_hash_dir)) {
				console.log( `Version is already active.\nNothing to do.` );
				process.exit(0);
			}
		}
		
		var pkg_dir = app_hash_dir + `/node_modules/${app_name}`;
		if (!fs.existsSync(pkg_dir)) die("App install dir was not found: " + pkg_dir);
		
		var pkg_file = pkg_dir + `/package.json`;
		if (!fs.existsSync(pkg_file)) die("App package.json file not found: " + pkg_file);
		
		var pkg = null;
		try { pkg = JSON.parse( fs.readFileSync(pkg_file, 'utf8') ); }
		catch(err) {
			die("Failed to load app package.json file: " + pkg_file + ": " + err);
		}
		
		if (pkg.name != app_name) die(`App names do not match: ${pkg_name} != ${app_name}`);
		if (!pkg.routes && !pkg.static && !pkg.redirects && !pkg.proxies) die(`App package.json is not a PoolNoodle app (missing required properties): ${pkg_file}`);
		
		var app_config_file = base_dir + '/conf/apps/' + app_name + '.json';
		
		// symlink part one
		this.symlink( pkg_dir, app_dir );
		console.log("App location: " + app_dir);
		
		// symlink part two
		this.symlink( pkg_file, app_config_file );
		console.log("Config File: " + app_config_file );
		
		console.log("Activation complete.");
		console.log("Triggering PoolNoodle hot reload...");
		
		// trigger PN hot reload
		cp.execSync( base_dir + '/bin/control.sh reload', { cwd: base_dir, stdio: 'inherit' } );
		
		console.log("Exiting.");
	}
	
};

if (!app[process.argv[2]]) die("App installer command unknown: " + process.argv[2]);
app[ process.argv[2] ]();
