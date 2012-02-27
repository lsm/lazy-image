//gifsicle 1.61+
//libjpeg/jpeg (jpegtran)
//optipng 0.6.3+
//pngcrush 1.7.0+
//graphicsmagick
//jpegoptim
//pngnq

var lazyImage = require('../index.js');

var serverOptions = {
  dbName: 'lazy_image_test',
  dbHost: '127.0.0.1',
  dbPort: 27017,
  dbCollection: 'images'
};

var server = lazyImage.createImageServer(serverOptions, '/image/upload/');

server.listen(7001, '127.0.0.1');