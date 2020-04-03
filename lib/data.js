const fs = require('fs');
const createJsonStringifyStream = require('./shared/create-json-stringify-stream');
const bootstrap = require('./shared/bootstrap');
const getCacheFilename = require('./shared/get-cache-filename');
const ensureDir = require('./shared/ensure-dir');

function collectData(modelConfig) {
    const startTime = Date.now();
    let fetchData = typeof modelConfig.data === 'function'
        ? modelConfig.data
        : () => {};

    return Promise.resolve(fetchData()).then(data => ({
        name: modelConfig.name,
        createdAt: new Date().toISOString(),
        elapsedTime: Date.now() - startTime,
        data
    }));
}

function getData(modelConfig, { rewriteCache, pretty } = {}) {
    const cacheFile = getCacheFilename(modelConfig);

    if (cacheFile && !rewriteCache) {
        try {
            const stat = fs.statSync(cacheFile);
            const cacheAge = Date.now() - stat.mtime;

            if (!modelConfig.cacheTtl || modelConfig.cacheTtl > cacheAge) {
                return Promise.resolve(fs.createReadStream(cacheFile));
            }
        } catch (e) {}
    }

    return collectData(modelConfig).then(data => {
        const jsonStream = createJsonStringifyStream(data, null, pretty || undefined);

        if (cacheFile) {
            jsonStream.pipe(fs.createWriteStream(ensureDir(cacheFile)));
        }

        return jsonStream;
    });
}

module.exports = bootstrap(function(options, config) {
    const { model, rewriteCache, pretty } = options;

    if (!model) {
        console.error('Model name is not specified. Use `--model` option to specify a model');
        process.exit(2);
    }

    const modelConfig = config.models[0];

    if (!modelConfig) {
        console.error(
            'Model `' + model + '` is not found in config. ' +
            'Available models: ' +
                (config.models.length ? config.models.map(model => model.slug).join(', ') : '<no model is available>')
        );
        process.exit(2);
    }

    return getData(modelConfig, { rewriteCache, pretty });
});
