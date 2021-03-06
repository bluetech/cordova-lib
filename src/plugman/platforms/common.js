/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var path = require('path');
var fs = require('fs-extra');
var common;

var cordovaUtil = require('../../cordova/util');
var CordovaError = require('cordova-common').CordovaError;
var xmlHelpers = require('cordova-common').xmlHelpers;

module.exports = common = {
    package_name: function (project_dir, www_dir) {

        var configPaths = [
            // preferred location if cordova >= 3.4
            path.join(project_dir, 'config.xml'),
            // older location
            path.join(www_dir || path.join(project_dir, 'www'), 'config.xml')
        ];

        var cordovaRoot = cordovaUtil.isCordova();
        if (cordovaRoot) {
            // CB-10662 If we're in cli project then add project's config as a fallback
            configPaths.push(path.join(cordovaRoot, 'config.xml'));
        }

        for (var i = 0; i < configPaths.length; i++) {
            var configPath = configPaths[i];
            // If no config there try next path
            if (!fs.existsSync(configPath)) continue;

            var widget_doc = xmlHelpers.parseElementtreeSync(configPath);
            return widget_doc._root.attrib.id;
        }

        // No configs found - fail with meaningful error message
        throw new CordovaError('Unable to find project\'s config in any of ' +
            'the following directories:\n\t' + configPaths.join('\n\t'));
    },
    // helper for resolving source paths from plugin.xml
    resolveSrcPath: function (plugin_dir, relative_path) {
        var full_path = path.resolve(plugin_dir, relative_path);
        return full_path;
    },
    // helper for resolving target paths from plugin.xml into a cordova project
    resolveTargetPath: function (project_dir, relative_path) {
        var full_path = path.resolve(project_dir, relative_path);
        return full_path;
    },
    copyFile: function (plugin_dir, src, project_dir, dest, link) {
        src = module.exports.resolveSrcPath(plugin_dir, src);
        if (!fs.existsSync(src)) throw new Error('"' + src + '" not found!');

        // check that src path is inside plugin directory
        var real_path = fs.realpathSync(src);
        var real_plugin_path = fs.realpathSync(plugin_dir);
        if (real_path.indexOf(real_plugin_path) !== 0) { throw new Error('"' + src + '" not located within plugin!'); }

        dest = module.exports.resolveTargetPath(project_dir, dest);

        // check that dest path is located in project directory
        if (dest.indexOf(project_dir) !== 0) { throw new Error('"' + dest + '" not located within project!'); }

        fs.ensureDirSync(path.dirname(dest));

        if (link) {
            common.symlinkFileOrDirTree(src, dest);
        } else {
            fs.copySync(src, dest);
        }
    },
    // Same as copy file but throws error if target exists
    copyNewFile: function (plugin_dir, src, project_dir, dest, link) {
        var target_path = common.resolveTargetPath(project_dir, dest);
        if (fs.existsSync(target_path)) { throw new Error('"' + target_path + '" already exists!'); }

        common.copyFile(plugin_dir, src, project_dir, dest, !!link);
    },
    symlinkFileOrDirTree: function symlinkFileOrDirTree (src, dest) {
        if (fs.existsSync(dest)) {
            fs.removeSync(dest);
        }

        if (fs.statSync(src).isDirectory()) {
            fs.ensureDirSync(dest);
            fs.readdirSync(src).forEach(function (entry) {
                symlinkFileOrDirTree(path.join(src, entry), path.join(dest, entry));
            });
        } else {
            fs.symlinkSync(path.relative(fs.realpathSync(path.dirname(dest)), src), dest);
        }
    },
    // checks if file exists and then deletes. Error if doesn't exist
    removeFile: function (project_dir, src) {
        var file = module.exports.resolveSrcPath(project_dir, src);
        fs.removeSync(file);
    },
    // deletes file/directory without checking
    removeFileF: function (file) {
        fs.removeSync(file);
    },
    // Sometimes we want to remove some java, and prune any unnecessary empty directories
    deleteJava: function (project_dir, destFile) {
        common.removeFileAndParents(project_dir, destFile, 'src');
    },
    removeFileAndParents: function (baseDir, destFile, stopper) {
        stopper = stopper || '.';
        var file = path.resolve(baseDir, destFile);
        if (!fs.existsSync(file)) return;

        common.removeFileF(file);

        // check if directory is empty
        var curDir = path.dirname(file);

        while (curDir !== path.resolve(baseDir, stopper)) {
            if (fs.existsSync(curDir) && fs.readdirSync(curDir).length === 0) {
                fs.rmdirSync(curDir);
                curDir = path.resolve(curDir, '..');
            } else {
                // directory not empty...do nothing
                break;
            }
        }
    },
    // handle <asset> elements
    asset: {
        install: function (asset, plugin_dir, www_dir) {
            if (!asset.src) {
                throw new Error('<asset> tag without required "src" attribute. plugin=' + plugin_dir);
            }
            if (!asset.target) {
                throw new Error('<asset> tag without required "target" attribute');
            }

            common.copyFile(plugin_dir, asset.src, www_dir, asset.target);
        },
        uninstall: function (asset, www_dir, plugin_id) {
            var target = asset.target || asset.src;

            if (!target) {
                throw new Error('<asset> tag without required "target" attribute');
            }

            common.removeFile(www_dir, target);
            common.removeFileF(path.resolve(www_dir, 'plugins', plugin_id));
        }
    },
    'js-module': {
        install: function (jsModule, plugin_dir, plugin_id, www_dir) {
            // Copy the plugin's files into the www directory.
            var moduleSource = path.resolve(plugin_dir, jsModule.src);
            // Get module name based on existing 'name' attribute or filename
            // Must use path.extname/path.basename instead of path.parse due to CB-9981
            var moduleName = plugin_id + '.' + (jsModule.name || path.basename(jsModule.src, path.extname(jsModule.src)));

            // Read in the file, prepend the cordova.define, and write it back out.
            var scriptContent = fs.readFileSync(moduleSource, 'utf-8').replace(/^\ufeff/, ''); // Window BOM
            if (moduleSource.match(/.*\.json$/)) {
                scriptContent = 'module.exports = ' + scriptContent;
            }
            scriptContent = 'cordova.define("' + moduleName + '", function(require, exports, module) { ' + scriptContent + '\n});\n';

            var moduleDestination = path.resolve(www_dir, 'plugins', plugin_id, jsModule.src);
            fs.writeFileSync(moduleDestination, scriptContent, 'utf-8');
        },
        uninstall: function (jsModule, www_dir, plugin_id) {
            var pluginRelativePath = path.join('plugins', plugin_id, jsModule.src);
            common.removeFileAndParents(www_dir, pluginRelativePath);
        }
    }
};
