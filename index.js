var genji = require('genji');
genji.extend(exports, require('./app'));
genji.extend(exports, require('./processer'));
genji.extend(exports, require('./model'));
exports.VERSION = '0.4.0';