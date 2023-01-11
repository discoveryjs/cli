const { deflateRawSync } = require('zlib');

module.exports = function createHtmlCompressedDataPrinter(maxChunkSize = 1024 * 1024, type = 'unknown/data', onDataChunk = '', onFinish = '') {
    const OPEN = `\n<script type="${type}">`;
    const CLOSE = `</script><script>\n(chunk=>{${
        onDataChunk
    }})(document.currentScript.previousSibling.text)</script>`;
    let buffer = new Uint8Array(maxChunkSize);
    let bufferSize = 0;

    function appendBuffer(chunkBuffer) {
        buffer.set(chunkBuffer, bufferSize);
        bufferSize += chunkBuffer.byteLength;
    }

    function flushBuffer() {
        const payload = buffer.subarray(0, bufferSize);
        const deflated = deflateRawSync(payload);
        const output = deflated.toString('base64');

        bufferSize = 0;

        return OPEN + output + CLOSE;
    }

    return {
        *push(chunk) {
            let chunkBuffer = chunk;

            while (bufferSize + chunkBuffer.byteLength >= maxChunkSize) {
                const usedChunkBufferSize = maxChunkSize - bufferSize;

                appendBuffer(chunkBuffer.subarray(0, usedChunkBufferSize));
                yield flushBuffer();

                chunkBuffer = chunkBuffer.subarray(usedChunkBufferSize);
            }

            appendBuffer(chunkBuffer);
        },
        *finish() {
            if (bufferSize > 0) {
                yield flushBuffer();
            }

            yield `\n<script>${onFinish}</script>`;
        }
    };
};
