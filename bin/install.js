// PoolNoodle Auto Installer
// Copyright (c) 2018 Joseph Huckaby, MIT License.
// https://github.com/jhuckaby/PoolNoodle

// To install, issue this command as root:
// curl -s https://raw.githubusercontent.com/jhuckaby/PoolNoodle/master/bin/install.js | node

var Path = require('path');
var fs = require('fs');
var util = require('util');
var os = require('os');
var cp = require('child_process');

var installer_version = '1.0';
var base_dir = '/opt/poolnoodle';
var log_dir = base_dir + '/logs';
var log_file = '';
var gh_repo_url = 'http://github.com/jhuckaby/PoolNoodle';
var gh_releases_url = 'https://api.github.com/repos/jhuckaby/PoolNoodle/releases';
var gh_head_tarball_url = 'https://github.com/jhuckaby/PoolNoodle/archive/master.tar.gz';

var print = function(msg) { 
	process.stdout.write(msg); 
	if (log_file) fs.appendFileSync(log_file, msg);
};
var warn = function(msg) { 
	process.stderr.write(msg); 
	if (log_file) fs.appendFileSync(log_file, msg);
};
var die = function(msg) {
	warn( "\nERROR: " + msg.trim() + "\n\n" );
	process.exit(1);
};
var logonly = function(msg) {
	if (log_file) fs.appendFileSync(log_file, msg);
};

if (process.getuid() != 0) {
	die( "The PoolNoodle auto-installer must be run as root." );
}

// create base and log directories
try { cp.execSync( "mkdir -p " + base_dir + " && chmod 775 " + base_dir ); }
catch (err) { die("Failed to create base directory: " + base_dir + ": " + err); }

try { cp.execSync( "mkdir -p " + log_dir + " && chmod 777 " + log_dir ); }
catch (err) { die("Failed to create log directory: " + log_dir + ": " + err); }

// start logging from this point onward
log_file = log_dir + '/install.log';
logonly( "\nStarting install run: " + (new Date()).toString() + "\n" );

print( 
	"\nPoolNoodle Installer v" + installer_version + "\n" + 
	"Copyright (c) 2018 PixlCore.com. MIT Licensed.\n" + 
	"Log File: " + log_file + "\n\n" 
);

process.chdir( base_dir );

var is_preinstalled = false;
var cur_version = '';
var new_version = process.argv[2] || '';

try {
	var stats = fs.statSync( base_dir + '/package.json' );
	var json = require( base_dir + '/package.json' );
	if (json && json.version) {
		cur_version = json.version;
		is_preinstalled = true;
	}
}
catch (err) {;}

var is_running = false;
if (is_preinstalled) {
	var pid_file = log_dir + '/pid.txt';
	try {
		var pid = fs.readFileSync(pid_file, { encoding: 'utf8' });
		is_running = process.kill( pid, 0 );
	}
	catch (err) {;}
}

print( "Fetching release list...\n");
logonly( "Releases URL: " + gh_releases_url + "\n" );

cp.exec('curl -s ' + gh_releases_url, function (err, stdout, stderr) {
	if (err) {
		print( stdout.toString() );
		warn( stderr.toString() );
		die("Failed to fetch release list: " + gh_releases_url + ": " + err);
	}
	
	var releases = null;
	try { releases = JSON.parse( stdout.toString() ); }
	catch (err) {
		die("Failed to parse JSON from GitHub: " + gh_releases_url + ": " + err);
	}
	
	if (!Array.isArray(releases)) die("Unexpected response from GitHub Releases API: " + gh_releases_url + ": Not an array");
	
	var release = null;
	for (var idx = 0, len = releases.length; idx < len; idx++) {
		var rel = releases[idx];
		var ver = rel.tag_name.replace(/^\D+/, '');
		rel.version = ver;
		
		if (!new_version || (ver == new_version)) { 
			release = rel; 
			new_version = ver; 
			idx = len; 
		}
	} // foreach release
	
	if (!release) {
		// no release found -- use HEAD rev?
		if (!new_version || new_version.match(/HEAD/i)) {
			release = {
				version: 'HEAD',
				tarball_url: gh_head_tarball_url
			};
		}
		else {
			die("Release not found: " + new_version);
		}
	}
	
	// sanity check
	if (is_preinstalled && (cur_version == new_version)) {
		if (process.argv[2]) print( "\nVersion " + cur_version + " is already installed.\n\n" );
		else print( "\nVersion " + cur_version + " is already installed, and is the latest.\n\n" );
		process.exit(0);
	}
	
	// proceed with installation
	if (is_preinstalled) print("Upgrading PoolNoodle from v"+cur_version+" to v"+new_version+"...\n");
	else print("Installing PoolNoodle v"+new_version+"...\n");
	
	if (is_running) {
		print("\n");
		try { cp.execSync( base_dir + "/bin/control.sh stop", { stdio: 'inherit' } ); }
		catch (err) { die("Failed to stop PoolNoodle: " + err); }
		print("\n");
	}
	
	// download tarball and expand into current directory
	var tarball_url = release.tarball_url;
	logonly( "Tarball URL: " + tarball_url + "\n" );
	
	cp.exec('curl -L ' + tarball_url + ' | tar zxf - --strip-components 1', function (err, stdout, stderr) {
		if (err) {
			print( stdout.toString() );
			warn( stderr.toString() );
			die("Failed to download release: " + tarball_url + ": " + err);
		}
		else {
			logonly( stdout.toString() + stderr.toString() );
		}
		
		try {
			var stats = fs.statSync( base_dir + '/package.json' );
			var json = require( base_dir + '/package.json' );
		}
		catch (err) {
			die("Failed to download package: " + tarball_url + ": " + err);
		}
		
		print( is_preinstalled ? "Updating dependencies...\n" : "Installing dependencies...\n");
		
		var npm_cmd = is_preinstalled ? "npm update" : "npm install";
		logonly( "Executing command: " + npm_cmd + "\n" );
		
		// install dependencies via npm
		cp.exec(npm_cmd, function (err, stdout, stderr) {
			if (err) {
				print( stdout.toString() );
				warn( stderr.toString() );
				die("Failed to install dependencies: " + err);
			}
			else {
				logonly( stdout.toString() + stderr.toString() );
			}
			
			try {
				// Set permissions on bin scripts
				fs.chmodSync( "bin/control.sh", "755" );
				
				// Create global symlink for our control script
				fs.symlinkSync( base_dir + "/bin/control.sh", "/usr/bin/noodle" );
			}
			catch (e) {;}
			
			var finish = function() {
				if (is_preinstalled) {
					print("Upgrade complete.\n\n");
					
					if (is_running) {
						try { cp.execSync( base_dir + "/bin/control.sh start", { stdio: 'inherit' } ); }
						catch (err) { die("Failed to start PoolNoodle: " + err); }
						print("\n");
					}
				}
				else {
					print("Installation complete.\n\n");
				}
				
				logonly( "Completed install run: " + (new Date()).toString() + "\n" );
				process.exit(0);
			};
			
			// Copy sample config if custom one doesn't exist
			fs.stat( "conf/config.json", function(err, stats) {
				if (err) {
					// file doesn't exist yet, copy over sample
					try { fs.mkdirSync( "conf/apps" ); } catch(e) {;}
					
					var inp = fs.createReadStream( "conf/sample-config.json" );
					var outp = fs.createWriteStream( "conf/config.json", { mode: "644" });
					inp.on('end', finish );
					inp.pipe( outp );
				}
				else finish();
			} );
			
		} ); // npm
	} ); // download
} ); // releases api
