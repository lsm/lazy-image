var genji = require('genji');
var Model = genji.Model;
var dateformat = require('dateformat');
var sha1 = genji.crypto.sha1;

/**
 * Image collection:
 *
 * {
 *   _id: '441547af33d49c4f37461fa87a5bb502b40687f2', // sha1 hash of the file content
 *   filename: '441547af33d49c4f37461fa87a5bb502b40687f2_100_200x300', // filename
 *   coarseLoc: '20120118', // the first sharding key, default is the date when the image is created
 *   data: '', // image binary data
 *   type: 'image/jpeg', // mime type
 *   length: 77031, // binary length of image
 *   created: ISODate("2011-08-27T17:45:29.976Z"), // date created
 *   url: 'http://p0.meituan.net/deal/201108/24/shotu1.jpg', // url of oringinal image (optional)
 *   quality: 100, // image quality (optional),
 *   width: 200, // image width in px (optional)
 *   height: 300 // image height in px (optional)
 * }
 *
 * filename: (hash-of-original-file)_(quality)_(widthxheight)
 * Quality 100 not resized (lossless compressed): 441547af33d49c4f37461fa87a5bb502b40687f2_100
 * Quality 70, resized 200x300: 441547af33d49c4f37461fa87a5bb502b40687f2_70_200x300
 *
 */

var ImageModel = Model('ImageModel', {
  fields: {
    // '441547af33d49c4f37461fa87a5bb502b40687f2', sha1 hash of the file content
    id: 'string',
    // '20120618' image creation date string, can be used as first sharding key (coarse location key)
    date: 'string',
    // generated filename: $hash_$date
    // could be used as second sharding key (search key)
    filename: 'string',
    // original filename
    name: 'string',
    // image blob
    data:function (value) {
      return !Buffer.isBuffer(value);
    },
    // mime type
    type: 'string',
    // binary length of image
    length: 'number',
    // url of oringinal image (optional)
    url: 'string',
    // image quality (optional),
    quality: 'number',
    // image width in px (optional)
    width: 'number',
    // image height in px (optional)
    height: 'number',
    // '1' if image has watermark, else omit this field, optional
    watermark: 'string',
    // date created
    created: 'date'
  },

  init: function (data) {
    !data.date && this.attr('date', dateformat(new Date, "yyyymmdd"));
    !data.created && this.attr('created', new Date);
    !data.quality && this.attr('quality', 100);
    !data.filename && this.attr('filename', this.attr('filename'));
    !data.hasOwnProperty('watermark') && this.attr('watermark', '0');
  },

  setData:function (value) {
    this.attr('id', sha1(value));
    return value;
  },

  getFilename:function () {
    var filenameHash = {id: this.attr('id')};
    filenameHash.quality = this.attr('quality') || 100;
    var size = this.attr(['width', 'height']);
    filenameHash.width = size.width || 0;
    filenameHash.height = size.height || 0;
    filenameHash.watermark = this.attr('watermark') || 0;
    var filename = sha1(JSON.stringify(filenameHash));
    filename += '_' + this.attr('date');
    return filename;
  }

});

exports.ImageModel = ImageModel;

//var i = {
//  id: sha1('1'),
//  name: 'test.jpg',
//  date: '20120918',
//  width: 120,
//  height: 210
//};
//var im = new ImageModel(i);
//
//console.log(im.toDoc());
//console.log(im.toData());