// Fork of https://github.com/Faleij/json-stream-stringify
const { Readable } = require('stream');
const PrimitiveType = 1;
const PromiseType = 2;
const ArrayType = 3;
const ObjectType = 4;
const ReadableStringType = 5;
const ReadableObjectType = 6;
const noop = () => {};

function isReadableStream(value) {
    return (
        typeof value.pipe === 'function' &&
        typeof value._read === 'function' &&
        typeof value._readableState === 'object'
    );
}

function getType(value) {
    if (value !== null && typeof value === 'object') {
        if (typeof value.then === 'function') {
            return PromiseType;
        }

        if (isReadableStream(value)) {
            return value._readableState.objectMode ? ReadableObjectType : ReadableStringType;
        }

        if (Array.isArray(value)) {
            return ArrayType;
        }

        return ObjectType;
    }

    return PrimitiveType;
}

function quoteString(string) {
    return JSON.stringify(string);
}

function primitiveToString(value) {
    switch (typeof value) {
        case 'string':
            return quoteString(value);

        case 'number':
            return Number.isFinite(value) ? String(value) : 'null';

        case 'boolean':
            return String(value);

        case 'undefined':
        case 'object':
            return 'null';

        default:
            // This should never happen, I can't imagine a situation where this executes.
            // If you find a way, please open a ticket or PR
            throw new Error(`Unknown type "${typeof value}". Please file an issue!`);
    }
}

function push() {
    this.push(this._stack.value);
    this.popStack();
}

function processObjectEntry(key) {
    const current = this._stack;

    if (current.firstEntry) {
        current.firstEntry = false;
    } else {
        this.push(',');
    }

    if (this.space) {
        this.push(`\n${this.space.repeat(this._depth)}${quoteString(key)}: `);
    } else {
        this.push(`${quoteString(key)}:`);
    }
}

function processObject() {
    const current = this._stack;

    // when no keys left, remove obj from stack
    if (current.index === current.keys.length) {
        if (this.space && !current.firstEntry) {
            this.push('\n' + this.space.repeat(this._depth - 1));
        }

        this.popStack();
        return;
    }

    const key = current.keys[current.index];

    this.processValue(key, current.value[key], processObjectEntry);
    current.index += 1;
}

function processArrayItem(index) {
    if (index !== '0') {
        this.push(',');
    }

    if (this.space) {
        this.push(`\n${this.space.repeat(this._depth)}`);
    }
}

function processArray() {
    const current = this._stack;

    if (current.index === current.value.length) {
        this.popStack();
        return;
    }

    this.processValue(String(current.index), current.value[current.index], processArrayItem);
    current.index += 1;
}

function createStreamReader(fn) {
    return function(size) {
        const current = this._stack;
        const data = current.value.read(size);

        if (data !== null) {
            current.firstRead = false;
            fn.call(this, data, current);
        } else {
            if (current.firstRead) {
                this.popStack();
            } else {
                current.firstRead = true;
                current.awaiting = true;
            }
        }
    };
}

const processReadableObject = createStreamReader(function(data, current) {
    this.processValue(String(current.index), data, processArrayItem);
    current.index += 1;
});

const processReadableString = createStreamReader(function(data) {
    this.push(data);
});

function normalizeReplacer(replacer) {
    if (typeof replacer === 'function') {
        return replacer;
    }

    if (Array.isArray(replacer)) {
        const whitelist = new Set(replacer
            .map(item => typeof item === 'string' || typeof item === 'number' ? String(item) : null)
            .filter(item => typeof item === 'string')
        );

        whitelist.add('');

        return (key, value) => whitelist.has(key) ? value : undefined;
    }

    return null;
}

function normalizeSpace(space) {
    if (typeof space === 'number') {
        if (!Number.isFinite(space) || space < 1) {
            return false;
        }

        return ' '.repeat(Math.min(space, 10));
    }

    if (typeof space === 'string') {
        return space.slice(0, 10) || false;
    }

    return false;
}

class JsonStringifyStream extends Readable {
    constructor(value, replacer, space) {
        super({});

        this.replacer = normalizeReplacer(replacer);
        this.space = normalizeSpace(space);
        this._depth = 0;

        this.error = null;
        this._processing = false;
        this._ended = false;

        this._readSize = 0;
        this._buffer = null;
        this._bufferOffset = 0;

        this._stack = null;
        this._visited = new WeakSet();

        this.pushStack({
            handler: () => {
                this.popStack();
                this.processValue('', value, noop);
            }
        });
    }

    processValue(key, value, callback) {
        if (value && typeof value.toJSON === 'function') {
            value = value.toJSON();
        }

        if (this.replacer !== null) {
            value = this.replacer.call(null, key, value);  // FIXME: `this` should be current value
        }

        if (typeof value === 'function' || typeof value === 'symbol') {
            value = undefined;
        }

        let type = getType(value);

        switch (type) {
            case PrimitiveType:
                if (callback !== processObjectEntry || value !== undefined) {
                    callback.call(this, key);
                    this.push(primitiveToString(value));
                }
                break;

            case PromiseType:
                this.pushStack({
                    handler: noop,
                    awaiting: true
                });

                Promise.resolve(value)
                    .then(resolved => {
                        this.popStack();
                        this.processValue(key, resolved, callback);
                        this.processStack();
                    })
                    .catch(error => {
                        this.abort(error);
                    });
                break;

            case ObjectType:
                callback.call(this, key);

                // check for circular structure
                if (this._visited.has(value)) {
                    return this.abort(new Error('Converting circular structure to JSON'));
                } else {
                    this._visited.add(value);
                }

                const keys = Object.keys(value);

                if (keys.length === 0) {
                    this.push('{}');
                    return;
                }

                this.push('{');
                this.pushStack({
                    handler: push,
                    value: '}'
                });
                this.pushStack({
                    handler: processObject,
                    value,
                    index: 0,
                    firstEntry: true,
                    keys
                });
                this._depth++;
                break;

            case ArrayType:
                callback.call(this, key);

                // check for circular structure
                if (this._visited.has(value)) {
                    return this.abort(new Error('Converting circular structure to JSON'));
                } else {
                    this._visited.add(value);
                }

                if (value.length === 0) {
                    this.push('[]');
                    return;
                }

                this.push('[');
                this.pushStack({
                    handler: push,
                    value: this.space ? '\n' + this.space.repeat(this._depth) + ']' : ']'
                });
                this.pushStack({
                    handler: processArray,
                    value,
                    index: 0
                });
                this._depth++;
                break;

            case ReadableStringType:
            case ReadableObjectType:
                callback.call(this, key);

                if (value.readableEnded) {
                    return this.abort(new Error('Readable Stream has ended before it was serialized. All stream data have been lost'));
                }

                if (value.readableFlowing) {
                    return this.abort(new Error('Readable Stream is in flowing mode, data may have been lost. Trying to pause stream.'));
                }

                if (type === ReadableObjectType) {
                    this.push('[');
                    this.pushStack({
                        handler: push,
                        value: this.space ? '\n' + this.space.repeat(this._depth) + ']' : ']'
                    });
                    this._depth++;
                }

                const self = this.pushStack({
                    handler: type === ReadableObjectType ? processReadableObject : processReadableString,
                    value,
                    index: 0,
                    firstRead: true,
                    awaiting: !value.readable || value.readableLength === 0
                });
                const continueProcessing = () => {
                    if (self.awaiting) {
                        self.awaiting = false;

                        if (this._stack === self) {
                            this.processStack();
                        }
                    }
                };

                value.once('error', error => this.abort(error));
                value.once('end', continueProcessing);
                value.on('readable', continueProcessing);
                break;
        }
    }

    abort(error) {
        this.error = error;
        this._stack = null;
        this._processing = false;
        this._ended = true;

        process.nextTick(() => {
            this._buffer = null;
            this.emit('error', error);
            this.push(null);
        });
    }

    pushStack(node) {
        node.prev = this._stack;
        return this._stack = node;
    }

    popStack() {
        const { handler, value } = this._stack;

        if (handler === processObject || handler === processArray || handler === processReadableObject) {
            this._visited.delete(value);
            this._depth -= 1;
        }

        this._stack = this._stack.prev;
    }

    processStack(size) {
        if (this._processing || this._ended) {
            return;
        }

        try {
            this._processing = true;

            while (this._stack !== null && !this._stack.awaiting) {
                this._stack.handler.call(this, size);

                if (!this._processing) {
                    return;
                }
            }

            this._processing = false;
        } catch (error) {
            this.abort(error);
            return;
        }

        if (this._stack === null && !this._ended) {
            this._ended = true;

            if (this._bufferOffset > 0) {
                super.push(this._buffer.slice(0, this._bufferOffset)); // flush buffer
            }

            this.push(null);
            this._buffer = null;
        }
    }

    push(data) {
        if (data !== null) {
            const max = this._bufferOffset + this._readSize;

            // prevent physical buffer overflow
            if (data.length > max) {
                this.pushStack({
                    handler: push,
                    value: data.slice(max)
                });
                data = data.slice(0, max);
            }

            // write to buffer
            this._bufferOffset += typeof data === 'string'
                ? this._buffer.write(data, this._bufferOffset)
                : data.copy(this._buffer, this._bufferOffset);

            // check logical buffer overflow
            if (this._bufferOffset < this._readSize) {
                return;
            }

            // flush buffer
            data = Uint8Array.prototype.slice.call(this._buffer, 0, this._readSize);
            this._buffer.copy(this._buffer, 0, this._readSize, this._bufferOffset);
            this._bufferOffset -= this._readSize;
            this._processing = false;
        }

        super.push(data);
    }

    _read(size) {
        if (this._ended) {
            return;
        }

        this._readSize = size || this.readableHighWaterMark;

        // allocate buffer
        if (this._buffer === null || this._buffer.length < 2 * this._readSize) {
            const newBuffer = Buffer.alloc(2 * this._readSize); // allocate x2 since string chars can be encoded as 2 bytes

            if (this._buffer !== null && this._bufferOffset > 0) {
                this._buffer.copy(newBuffer, 0, 0, this._bufferOffset);
            }

            this._buffer = newBuffer;
        }

        // start processing
        this.processStack(size);
    }
}

module.exports = function createJsonStringifyStream(value, replacer, spaces) {
    return new JsonStringifyStream(value, replacer, spaces);
};
