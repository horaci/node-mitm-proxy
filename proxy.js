var https = require('https')
  , http  = require('http')
  , path  = require('path')
  , fs    = require('fs')
  , net   = require('net')
  , sys   = require('sys')
  , url   = require('url')
  , clrs  = require('colors')
  , EE    = require('events').EventEmitter
  , pw    = require(path.join(__dirname, 'lib', 'proxy_writter.js'))

var process_options = function(proxy_options) {
  var options = proxy_options || {}

  if(!options.proxy_port)            options.proxy_port       = 8080;
  if(!options.mitm_port)             options.mitm_port        = 8000;
  if(!options.verbose === false)     options.verbose          = true;
  if(!options.proxy_write === true)  options.proxy_write      = false;
  if(!options.proxy_write_path)      options.proxy_write_path = '/tmp/proxy';
  if(!options.key_path)              options.key_path         = path.join(__dirname, 'certs', 'agent2-key.pem')
  if(!options.cert_path)             options.cert_path        = path.join(__dirname, 'certs', 'agent2-cert.pem')
  return options;
}

var Processor = function(proc) {
  this.processor = function() {
    this.methods = new proc(this);
    EE.call(this.methods);
  }
  sys.inherits(this.processor, EE);
}

var process_url = function(request, type, processor) {
  var req_url = url.parse(request.url, true);
  if(!req_url.protocol) req_url.protocol = type + ":";
  if(!req_url.hostname) req_url.hostname = request.headers.host;

  if(processor && processor.methods.url_rewrite) {
    req_url = processor.methods.url_rewrite(req_url) || req_url;
  }

  return req_url;
}

var handle_request = function(that, request, response, type) {
  var processor = that.processor_class ? new that.processor_class.processor() : null;
  var req_url   = process_url(request, type, processor);
  var hostname  = req_url.hostname;
  var pathname  = req_url.pathname + ( req_url.search || "");
  var proxy_writter;

  if(processor) processor.emit('request', request, req_url);

  if(that.options.verbose) console.log(type.blue + " proxying to " +  url.format(req_url).green);
  if(that.options.proxy_write) proxy_writter = new pw(hostname, pathname)

  var request_options = {
      host: hostname
    , port: req_url.port || (type == "http" ? 80 : 443)
    , path: pathname
    , headers: request.headers
    , method: request.method
  }

  var proxy_request = (req_url.protocol == "https:" ? https : http).request(request_options, function(proxy_response) {
    if(processor) processor.emit("response", proxy_response);

    proxy_response.on("data", function(d) {
      response.write(d);
      if(that.options.proxy_write) proxy_writter.write(d);
      if(processor) processor.emit("response_data", d);
    });

    proxy_response.on("end", function() {
      response.end();
      if(that.options.proxy_write) proxy_writter.end();
      if(processor) processor.emit("response_end");
    })

    proxy_response.on('close', function() {
      if(processor) processor.emit("response_close");
      proxy_response.connection.end();
    })

    proxy_response.on("error", function(err) {})
    response.writeHead(proxy_response.statusCode, proxy_response.headers);
  })

  proxy_request.on('error', function(err) {
    response.end(); 
  })

  request.on('data', function(d) {
    proxy_request.write(d, 'binary');
    if(processor) processor.emit("request_data", d);
  });

  request.on('end', function() {
    proxy_request.end();
    if(processor) processor.emit("request_end");
  });

  request.on('close', function() {
    if(processor) processor.emit("request_close");
    proxy_request.connection.end();
  })

  request.on('error', function(exception) { 
    response.end(); 
  });
}


module.exports = function(proxy_options, processor_class) {
  this.options = process_options(proxy_options);
  this.processor_class = processor_class ? new Processor(processor_class) : null;

  var that = this;
  var https_opts = {
    key: fs.readFileSync(this.options.key_path, 'utf8'),
    cert: fs.readFileSync(this.options.cert_path, 'utf8')
  };

  var mitm_server = https.createServer(https_opts, function (request, response) {
    handle_request(that, request, response, "https");
  });

  mitm_server.addListener('error', function() {
    sys.log("error on server?")
  })

  mitm_server.listen(this.options.mitm_port);
  if(this.options.verbose) console.log('https man-in-the-middle proxy server'.blue + ' started '.green.bold + 'on port '.blue + (""+this.options.mitm_port).yellow);

  var server = http.createServer(function(request, response) {
    handle_request(that, request, response, "http");
  });

  // Handle connect request (for https)
  server.addListener('upgrade', function(req, socket, upgradeHead) {
    var proxy = net.createConnection(that.options.mitm_port, 'localhost');

    proxy.on('connect', function() {
      socket.write( "HTTP/1.0 200 Connection established\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n"); 
    });

    // connect pipes
    proxy.on( 'data', function(d) { socket.write(d)   });
    socket.on('data', function(d) { try { proxy.write(d) } catch(err) {}});

    proxy.on( 'end',  function()  { socket.end()      });
    socket.on('end',  function()  { proxy.end()       });

    proxy.on( 'close',function()  { socket.end()      });
    socket.on('close',function()  { proxy.end()       });

    proxy.on( 'error',function()  { socket.end()      });
    socket.on('error',function()  { proxy.end()       });
  });

  server.addListener('error', function() {
    sys.log("error on server?")
  })

  server.listen(this.options.proxy_port);
  if(this.options.verbose) console.log('http proxy server '.blue + 'started '.green.bold + 'on port '.blue + (""+this.options.proxy_port).yellow);
}
