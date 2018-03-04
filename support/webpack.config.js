
// var webpack = require('webpack');
var UglifyJSPlugin = require('uglifyjs-webpack-plugin');

module.exports = {
  name: 'default',
  entry: './lib/index.js',
  output: {
    library: 'io',
    libraryTarget: 'umd',
    filename: 'socket.io.js'
  },
  externals: {
    global: glob()
  },
  devtool: 'source-map',
  plugins: [
    new UglifyJSPlugin({
      sourceMap: true,
      uglifyOptions: {
        output: {
          beautify: false
        }
      }
    })
  ],
  module: {
    loaders: [{
      test: /\.js$/,
      exclude: /(node_modules|bower_components)/,
      loader: 'babel', // 'babel-loader' is also a legal name to reference
      query: { presets: ['es2015'] }
    }, {
      test: /\json3.js/,
      loader: 'imports?define=>false'
    }, {
      test: /\.json$/,
      loader: 'json-loader'
    }]
  }
};

/**
 * Populates `global`.
 *
 * @api private
 */

function glob () {
  return 'typeof self !== "undefined" ? self : ' +
    'typeof window !== "undefined" ? window : ' +
    'typeof global !== "undefined" ? global : {}';
}
