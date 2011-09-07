//gifsicle 1.61+
//libjpeg/jpeg (jpegtran)
//optipng 0.6.3+
//pngcrush 1.7.0+
//graphicsmagick
//jpegoptim
//pngnq

var lazyImage = require('./index');

var serverOptions = {
  dbName: 'lazy_image_test',
  dbHost: '127.0.0.1',
  dbPort: 27017,
  dbRootCollection: 'images'
};

var server = lazyImage.createServer(serverOptions);

server.listen(7001, '127.0.0.1');