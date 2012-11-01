//gifsicle 1.61+
//libjpeg/jpeg (jpegtran)
//optipng 0.6.3+
//pngcrush 1.7.0+
//graphicsmagick
//jpegoptim
//pngnq

var genji = require('genji');
var LazyImage = require('../index.js');
var Path = require('path');

var options = {
  urlRoot: '^/image',
  dbName: 'lazy_image_test',
  dbHost: '127.0.0.1',
  dbPort: 27017,
  dbCollection: 'images',
  exts:['.png', '.jpg', '.jpeg', '.gif'],
  maxImageSize:8388608 // 8MB
};

genji.use('conditional-get');

// upload app
var uploadApp = new LazyImage.ImageUploadApp(options);
genji.loadApp(uploadApp);

// access app
var accessApp = new LazyImage.ImageAccessApp(options);
genji.loadApp(accessApp);

// process app
var processApp = new LazyImage.ImageProcessApp(options);
genji.loadApp(processApp);

// index.html and jquery
var route = genji.route();

route.get('^/$', function (handler) {
  handler.staticFile(Path.join(__dirname, './index.html'));
});

route.get('^/jquery-1.7.1.min.js', function (handler) {
  handler.staticFile(Path.join(__dirname, './jquery-1.7.1.min.js'));
});

var server = genji.createServer();

server.listen(7001, '127.0.0.1');

process.on('uncaughtException', function(err) {
  console.log('LazyImage error:');
  console.log(err.stack || err);
});