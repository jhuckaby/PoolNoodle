// PoolNoodle App Pruner
// Copyright (c) 2025 Joseph Huckaby, MIT License.
// https://github.com/jhuckaby/PoolNoodle

// Prune all app versions that are not active:
// noodle prune

const Path = require('path');
const fs = require('fs');
const util = require('util');
const os = require('os');
const cp = require('child_process');
const Tools = require('pixl-tools');

const base_dir = '/opt/poolnoodle';
const app_base_dir = base_dir + '/apps';

function die(msg) {
	console.error( "\nERROR: " + msg + "\n");
	process.exit(1);
}

/* 	"_poolnoodle": {
		"app_name": "www.pixlcore.com",
		"app_str": "github:pixlcore/www.pixlcore.com#v1.0.6",
		"app_hash": "1230f62d15d54526"
	}
*/

Tools.glob.sync( app_base_dir + '/versions/*' ).forEach( function(dir) {
	var outer_pkg = JSON.parse( fs.readFileSync( dir + '/package.json', 'utf8' ) );
	var pn_meta = outer_pkg._poolnoodle;
	var app_dir = app_base_dir + '/' + pn_meta.app_name;
	
	console.log( "\n" + pn_meta.app_str + ":" );
	
	if (!fs.existsSync(app_dir)) {
		console.log("App is not installed (orphaned dir), deleting: " + dir);
		Tools.rimraf.sync(dir);
		return;
	}
	
	var target = Path.resolve( fs.readlinkSync(app_dir) );
	if (target.includes(dir)) {
		console.log( `Version is currently active, skipping: ` + dir );
		return;
	}
	else {
		console.log( `Version is NOT active, deleting: ` + dir );
		Tools.rimraf.sync(dir);
	}
} );

console.log("\nDone.\n");
