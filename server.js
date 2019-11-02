(function() {
    'use strict';
    /*global console,require,__dirname,process*/
    /*jshint es3:false*/
var cluster = require('cluster');

// Code to run if we're in the master process
if (cluster.isMaster) {
    // Count the machine's CPUs
    var cpuCount = require('os').cpus().length;

    // Create a worker for each CPU
    for (var i = 0; i < cpuCount; i += 1) {
        cluster.fork();
    }

    // Listen for terminating workers
    cluster.on('exit', function (worker) {
        // Replace the terminated workers
        console.log('Worker ' + worker.id + ' died :('); // eslint-disable-line no-console
        cluster.fork();
    });

// Code to run if we're in a worker process
} else {
	
    var express = require('express');
    var compression = require('compression');
    var fs = require('fs');
    var url = require('url');
    var request = require('request');
   //定义gzip header
    var gzipHeader = Buffer.from("1F8B08", "hex");

    var yargs = require('yargs').options({
        'port' : {
            'default' : process.env.PORT || 8000,
            'description' : 'Port to listen on.'
        },
        'public' : {
            'type' : 'boolean',
            'description' : 'Run a public server that listens on all interfaces.'
        },
        'upstream-proxy' : {
            'description' : 'A standard proxy server that will be used to retrieve data.  Specify a URL including port, e.g. "http://proxy:8000".'
        },
        'bypass-upstream-proxy-hosts' : {
            'description' : 'A comma separated list of hosts that will bypass the specified upstream_proxy, e.g. "lanhost1,lanhost2"'
        },
        'help' : {
            'alias' : 'h',
            'type' : 'boolean',
            'description' : 'Show this help.'
        }
    });
    var argv = yargs.argv;

    if (argv.help) {
        return yargs.showHelp();
    }

    // eventually this mime type configuration will need to change
    // https://github.com/visionmedia/send/commit/d2cb54658ce65948b0ed6e5fb5de69d022bef941
    //定义模型及地形需要的mimeType
    var mime = express.static.mime;
    mime.define({
        'application/json' : ['czml', 'json', 'geojson', 'topojson'],           
		    'application/vnd.quantized-mesh' : ['terrain'],
        'model/vnd.gltf+json' : ['gltf'],
        'model/vnd.gltf.binary' : ['glb', 'bgltf'],
        'application/octet-stream' : ['b3dm', 'pnts', 'i3dm', 'cmpt', 'terrain'],
        'text/plain' : ['glsl']        
    });

    var app = express();
    app.use(compression());

    app.use(function(req, res, next) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
		    res.header("Access-Control-Allow-Methods","PUT,POST,GET,DELETE,OPTIONS");
		    res.header("X-Powered-By",'3.2.1');		
		    res.header("Content-Type", "application/json;charset=utf-8");
	    	next();
    });

    function checkGzipAndNext(req, res, next) {
        var buffer = Buffer.alloc(3);
        var reqUrl = url.parse(req.url, true);
        var filePath = reqUrl.pathname.substring(1);

        var readStream = fs.createReadStream(filePath, { start: 0, end: 2 });
		
        readStream.on('error', function(err) {
            next();
        });

        readStream.on('data', function(chunk) {
        //开启地形及模型瓦片gzip
	  		res.header("Content-Type", "application/vnd.quantized-mesh,application/octet-stream;extensions=watermask");
            if (chunk.equals(gzipHeader)) {
                res.header('Content-Encoding', 'gzip');	
				
            }
            next();
        });
    }

   //检测地形及模型瓦片gzip
    var knownTilesetFormats = [/\.terrain/, /\.b3dm/, /\.pnts/, /\.i3dm/, /\.cmpt/, /\.glb/, /tileset.*\.json$/];
    app.get(knownTilesetFormats, checkGzipAndNext);

    // Custom code for serving TilesetWithExpiration. When points.pnts is requested it cycles between the tiles in the cache folder.
    var expirationPntsPath = '/data/tilesets/TilesetWithExpiration/points.pnts';
    var expirationCacheDirectory = '/data/tilesets/TilesetWithExpiration/cache/';
    var expirationCacheLength = 5;
    var expireCount = 0;

    app.use(expirationPntsPath, function(req, res) {
        var pntsPath = expirationCacheDirectory +  'points_' + expireCount + '.pnts';
        expireCount = (expireCount + 1) % expirationCacheLength;
        res.sendFile(pntsPath, {root: __dirname});
        // Don't call next() because we don't need to run the express.static middleware
    });

    app.use(express.static(__dirname));

    function getRemoteUrlFromParam(req) {
        var remoteUrl = req.params[0];
        if (remoteUrl) {
            // add http:// to the URL if no protocol is present
            if (!/^https?:\/\//.test(remoteUrl)) {
                remoteUrl = 'http://' + remoteUrl;
            }
            remoteUrl = url.parse(remoteUrl);
            // copy query string
            remoteUrl.search = url.parse(req.url).search;
        }
        return remoteUrl;
    }

    var dontProxyHeaderRegex = /^(?:Host|Proxy-Connection|Connection|Keep-Alive|Transfer-Encoding|TE|Trailer|Proxy-Authorization|Proxy-Authenticate|Upgrade)$/i;

    function filterHeaders(req, headers) {
        var result = {};
        // filter out headers that are listed in the regex above
        Object.keys(headers).forEach(function(name) {
            if (!dontProxyHeaderRegex.test(name)) {
                result[name] = headers[name];
            }
        });
        return result;
    }

    var upstreamProxy = argv['upstream-proxy'];
    var bypassUpstreamProxyHosts = {};
    if (argv['bypass-upstream-proxy-hosts']) {
        argv['bypass-upstream-proxy-hosts'].split(',').forEach(function(host) {
            bypassUpstreamProxyHosts[host.toLowerCase()] = true;
        });
    }

    app.get('/*', function(req, res, next) {
        // look for request like http://localhost:8080/
        var remoteUrl = getRemoteUrlFromParam(req);
        if (!remoteUrl) {
            // look for request like http://localhost:8080/
            remoteUrl = Object.keys(req.query)[0];
            if (remoteUrl) {
                remoteUrl = url.parse(remoteUrl);
            }
        }

        if (!remoteUrl) {
            return res.send(400, 'No url specified.');
        }

        if (!remoteUrl.protocol) {
            remoteUrl.protocol = 'http:';
        }

        var proxy;
        if (upstreamProxy && !(remoteUrl.host in bypassUpstreamProxyHosts)) {
            proxy = upstreamProxy;
        }

        // encoding : null means "body" passed to the callback will be raw bytes

        request.get({
            url : url.format(remoteUrl),
            headers : filterHeaders(req, req.headers),
            encoding : null,
            proxy : proxy
        }, function(error, response, body) {
            var code = 500;

            if (response) {
                code = response.statusCode;
                res.header(filterHeaders(req, response.headers));
            }

            res.send(code, body);
        });
    });

    var server = app.listen(argv.port, '0.0.0.0', function() {
        if (argv.public) {
            console.log('Cesium data server running publicly.  Connect to http://localhost:%d/', server.address().port);
        } else {
            console.log('Cesium data server running locally.  Connect to http://localhost:%d/', server.address().port);
        }
    });

    server.on('error', function (e) {
        if (e.code === 'EADDRINUSE') {
            console.log('Error: Port %d is already in use, select a different port.', argv.port);
            console.log('Example: node server.js --port %d', argv.port + 1);
        } else if (e.code === 'EACCES') {
            console.log('Error: This process does not have permission to listen on port %d.', argv.port);
            if (argv.port < 1024) {
                console.log('Try a port number higher than 1024.');
            }
        }
        console.log(e);
        process.exit(1);
    });

    server.on('close', function() {
        console.log('Cesium data server stopped.');
    });

    process.on('SIGINT', function() {
        server.close(function() {
            process.exit(0);
        });
    });
}
})();
