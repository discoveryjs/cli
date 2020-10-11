const fs = require('fs');
const path = require('path');
const os = require('os');
const { stringifyStream } = require('@discoveryjs/json-ext');
const { getActualCache, genCacheFilename, genCacheInfo } = require('./shared/cache');
const bootstrap = require('./shared/bootstrap');
const ensureDir = require('./shared/ensure-dir');
const genData = require('./data');

// modes
// - default – get cache or generate new one if not exists
// - readonly – get cache
// - force – generate cache (ignore existing)
module.exports = bootstrap.model(function getCache(modelConfig, { mode, pretty }) {
    const { slug } = modelConfig;
    const actualCache = mode !== 'force'
        ? getActualCache(modelConfig)
        : false;

    if (actualCache || mode === 'readonly') {
        return Promise.resolve(actualCache);
    }

    const newCacheFilename = genCacheFilename(modelConfig);
    const tmpCacheFilename = path.join(os.tmpdir(), path.basename(newCacheFilename));
    console.log('[cache]', slug, 'start cache generation, target file:', path.relative(process.cwd(), newCacheFilename));

    return genData.fn(modelConfig).then(data => new Promise((resolve, reject) => {
        const startWriteTime = Date.now();

        stringifyStream(data, null, pretty)
            .on('error', reject)
            .pipe(fs.createWriteStream(tmpCacheFilename))
            .on('error', reject)
            .on('finish', () => {
                fs.renameSync(tmpCacheFilename, ensureDir(newCacheFilename));

                console.log('[cache]', slug, 'cache written in', Date.now() - startWriteTime, 'ms');
                resolve({
                    ...genCacheInfo(slug, newCacheFilename),
                    created: true
                });
            });
    }));
});