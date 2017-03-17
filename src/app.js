'use strict';

var http = require('http'),
    fs = require('fs'),
    url = require('url'),
    util = require('util'),
    templatePattern = /\/([^\/]+)\/([^\/]+)/;

function defined (obj) {
    return typeof obj !== 'undefined';
}

function type (obj) {
    if (util.isArray(obj)) {
        return 'array';
    }
    else if (typeof obj === 'number' && obj.toString().indexOf('.') < 0) {
        return 'integer';
    }
    else if (obj === null) {
        return 'null';
    }
    else {
        return typeof obj;
    }
}

function intercept (obj, fn, interceptor, resultProcessor) {
    var original = obj[fn];
    obj[fn] = function () {
        var args = Array.prototype.slice.call(arguments);

        // Allow returning new args array to change parameters to intercepted function
        var nextArgs = interceptor.apply(this, args) || args;
        var result = original.apply(this, nextArgs);

        if (defined(resultProcessor)) {
            resultProcessor(result);
        }
        return result;
    };
}

function capture (baseURL, filename) {
    var host = url.parse(baseURL).host,
        basePath = url.parse(baseURL).pathname;

    function read () {
        return JSON.parse(fs.readFileSync(filename));
    }

    function write (spec) {
        fs.writeFileSync(filename, JSON.stringify(spec, null, 4));
    }

    function withSpec (handler) {
        var spec = read();
        handler(spec);
        write(spec);
    }

    function shouldCapture (options) {
        var requestHost = options.hostname || options.host || 'localhost';
        if (options.port) {
            requestHost += ':' + options.port;
        }
        return requestHost.toLowerCase() === host.toLowerCase() &&
            options.path.indexOf(basePath) === 0;
    }

    function isTemplated (path) {
        return templatePattern.test(path);
    }

    function templatize (path) {
        return util.format('/%s/{id}', path.match(templatePattern)[1]);
    }

    function getTemplateIdFrom (path) {
        return path.match(templatePattern)[2];
    }

    function getPathFrom (requestOptions) {
        var parts = url.parse(requestOptions.path, true),
            path = parts.pathname.replace(basePath, '/');

        if (isTemplated(path)) {
            path = templatize(path);
        }

        return path;
    }

    function getQueryFrom (requestOptions) {
        return url.parse(requestOptions.path, true).query;
    }

    function getPathSpec (path, spec) {
        if (!defined(spec.paths[path])) {
            spec.paths[path] = {};
        }

        return spec.paths[path];
    }

    function singularize (resourceType) {
        return resourceType.replace(/s$/, '');
    }

    function getResourceTypeFrom (path) {
        if (isTemplated(path)) {
            return singularize(path.match(templatePattern)[1]);
        }
        else {
            return path.replace('/', '');
        }
    }

    function getOperationSpec (method, pathSpec) {
        if (!defined(pathSpec[method.toLowerCase()])) {
            pathSpec[method.toLowerCase()] = {
                responses: {},
                parameters: [],
                consumes: ['application/json'],
                produces: ['application/json']
            };
        }

        return pathSpec[method.toLowerCase()];
    }

    function ensureTypeAdded (spec, obj) {
        if (!defined(spec.type)) {
            spec.type = type(obj);
        }

        // I saw the array for type field here: https://developer.nytimes.com/most_popular_api_v2.json/swagger.json
        if (type(spec.type) === 'string' && spec.type !== type(obj)) {
            spec.type = [spec.type, type(obj)];
        }
        else if (type(spec.type) === 'array' && spec.type.indexOf(type(obj)) < 0) {
            spec.type.push(type(obj));
        }
    }

    function ensureAllPropertiesAdded (obj, propertiesSpec) {
        Object.keys(obj).forEach(function (name) {
            propertiesSpec[name] = propertiesSpec[name] || {};

            if (type(obj[name]) === 'object' || type(obj[name]) === 'array') {
                ensureSchemaAdded(obj[name], propertiesSpec[name]);
            }
            else {
                ensureTypeAdded(propertiesSpec[name], obj[name]);
            }
        });
    }

    function ensureSchemaAdded (obj, schemaSpec) {
        ensureTypeAdded(schemaSpec, obj);

        if (obj === null) {
            return;
        }

        switch (type(obj)) {
            case 'array':
                schemaSpec.items = schemaSpec.items || {};
                obj.forEach(function (item) {
                    ensureSchemaAdded(item, schemaSpec.items);
                });
                break;

            case 'object':
                schemaSpec.properties = schemaSpec.properties || {};
                ensureAllPropertiesAdded(obj, schemaSpec.properties);
                break;

            case 'string':
                // Save values for possible enums
                // Heuristic: if length < 10, possible enum
                if (obj.length < 10) {
                    schemaSpec.enum = schemaSpec.enum || [];
                    if (schemaSpec.enum.indexOf(obj) < 0) {
                        schemaSpec.push(obj);
                    }
                }
                break;
        }
    }

    function ensureParametersAdded (params, paramType, paramsSpec) {
        Object.keys(params).forEach(function (name) {
            var spec = paramsSpec.find(function (param) { return param.name === name; });

            if (!defined(spec)) {
                spec = { name: name, in: paramType };
                if (paramType === 'body') {
                    spec.schema = {};
                }
                else {
                    spec.type = type(params[name]);
                }
                paramsSpec.push(spec);
            }

            if (spec.in !== paramType) {
                console.error('Spec parameter %s in both %s and %s', name, spec.in, paramType);
            }

            if (paramType !== 'body') {
                ensureTypeAdded(spec, params[name]);
            }

            if (paramType === 'body') {
                ensureSchemaAdded(params[name], spec.schema);
            }
        });
    }

    function ensureResponseAdded (statusCode, body, responsesSpec) {
        if (!defined(responsesSpec[statusCode])) {
            responsesSpec[statusCode] = {
                schema: {},
                examples: { 'application/json': body } // Only grabs first example...
            };
        }

        ensureSchemaAdded(body, responsesSpec[statusCode].schema);
    }

    function isJSON (str) {
        try {
            JSON.parse(str);
            return true;
        }
        catch (e) {
            return false;
        }
    }

    var currentRequest = {};

    intercept(http, 'request', function (options, callback) {
        if (typeof options === 'string') {
            options = url.parse(options);
        }

        if (!shouldCapture(options)) {
            return;
        }

        var callbackWithInterceptor = function (response) {
            var packets = [];

            response.on('data', function (chunk) {
                packets.push(chunk);
            });

            response.on('end', function () {
                withSpec(function (spec) {
                    // From request...
                    var path = getPathFrom(currentRequest.options),
                        query = getQueryFrom(currentRequest.options),
                        pathSpec = getPathSpec(path, spec),
                        operationSpec = getOperationSpec(currentRequest.options.method, pathSpec),
                        resourceType = getResourceTypeFrom(path),
                        bodyParam = {},
                        responseBody = Buffer.concat(packets).toString('utf8');

                    if (!isJSON(responseBody)) {
                        // Don't capture for non-JSON responses
                        return;
                    }

                    ensureParametersAdded(query, 'query', operationSpec.parameters);
                    if (isTemplated(path)) {
                        ensureParametersAdded({ id: getTemplateIdFrom(path) }, 'path', operationSpec.parameters);
                    }

                    if (isJSON(currentRequest.body)) {
                        bodyParam[resourceType] = JSON.parse(currentRequest.body);
                        ensureParametersAdded(bodyParam, 'body', operationSpec.parameters);
                    }

                    ensureResponseAdded(response.statusCode, JSON.parse(responseBody), operationSpec.responses);
                });
            });

            if (defined(callback)) {
                callback(response);
            }
        };

        // Save for next call
        currentRequest = { options: options, body: '' };

        // Return changed callback
        return [options, callbackWithInterceptor];
    }, function (request) {
        intercept(request, 'write', function (body) {
            currentRequest.body = body;
        });
    });

    // Initialize with bare-bones spec
    write({ swagger: '2.0', paths: {} });
}

module.exports = {
    capture: capture
};
