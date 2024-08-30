const Wire = require('bittorrent-protocol');
const ltDontHave = require('lt_donthave');

class FastWebConn extends Wire {
	constructor(url, torrent, cache) {
		super();

		this._torrent = torrent;

		this.webPeerId = sha1.sync(url);
		this.cache = cache;
		this.connId = url;
		this.url = url;

		// Init buffer for the whole file
		this.data = new Uint8Array(torrent.length);

		this.numPieces = torrent.pieces.length;
		this.indexBreak = null;
		this.indexStart = 0;
		this.loaded = 0;
		this.queue = {};

		this.setKeepAlive(true);

		this.use(ltDontHave());

		this.once('handshake', (infoHash, peerId) => {
			if (this.destroyed) {
				return;
			}

			this.handshake(infoHash, this.webPeerId);

			const bitfield = new BitField(this.numPieces);

			for (let i = 0; i <= this.numPieces; i++) {
				bitfield.set(i, true);
			}

			this.bitfield(bitfield);
		});

		this.once('interested', () => {
			this.unchoke();
		});

		this.on('request', (pieceIndex, offset, length, cb) => {
			if (this.cache[pieceIndex]) {
				// Return already cached chunks
				toBuffer(this.cache[pieceIndex], cb);
				this.maxQueued = pieceIndex;
			} else {
				// Handle the case where WebTorrent requests the last
				// chunk first to get meta data for certain media
				if (pieceIndex > 0 && pieceIndex === this.numPieces - 1) {
					this.downloadLastPiece(cb);
				} else {
					// Detect if the user is seeking in streamable media
					// so download can be restarted from proper index
					if (this.controller && this.indexBreak === null && pieceIndex !== this.lastQueued + 1) {
						this.indexBreak = this.lastQueued;
						this.indexStart = pieceIndex;
					}

					// Add callback to pending queue
					this.queuePiece(pieceIndex, cb);

					// Start download on initial request
					this.download();
				}
			}
		});
	}

	// Add callback for pending chunk requests
	queuePiece(index, cb) {
		if (this.queue[index]) {
			return;
		}

		this.lastQueued = index;
		this.queue[index] = cb;
		this.ready();
	}

	// Get the last chunk of a file
	downloadLastPiece(cb) {
		const { length, lastPieceLength } = this._torrent;
		const opts = {};

		if (length > lastPieceLength) {
			opts.headers = { range: `bytes=${length - lastPieceLength}-${length}` };
		}

		fetch(this.url, opts)
			.then((response) => {
				return response.arrayBuffer();
			})
			.then((data) => {
				cb(null, new Uint8Array(data));
			})
			.catch((err) => {
				cb(err);
			});
	}

	// Start downloading file in a single request
	download() {
		// Don't download if torrent not active, or download already started
		if (!this._torrent || this.controller) {
			return;
		}

		// Controller makes it possible to restart the request as necessary
		this.controller = new AbortController();

		const { pieceLength, length } = this._torrent;
		const { signal } = this.controller;
		const opts = { signal };

		let indexStart = -1;
		let indexEnd = -1;

		// Detect a range of uncached chunks
		for (let i = this.indexStart; i < this.numPieces; i++) {
			if (!this.cache[i] && indexStart === -1) {
				indexStart = i;
			}

			if (indexStart > -1 && this.cache[i]) {
				indexEnd = i;
			}

			if (indexStart > -1 && indexEnd > -1) {
				break;
			}
		}

		// Map chunk indexes onto a byte range
		const rangeStart = (indexStart > -1 ? indexStart : 0) * pieceLength;
		const rangeEnd = indexEnd > -1 ? Math.min(indexEnd * pieceLength, length) : length;

		// If range is not the entire file, add headers
		if (rangeStart > 0 || rangeEnd < length) {
			opts.headers = { range: `bytes=${rangeStart}-${rangeEnd}` };
		}

		// Measure amount loaded from range start
		this.loaded = rangeStart;

		// If there are any uncached chunks, start download
		if (rangeStart !== rangeEnd && Object.keys(this.cache).length < this.numPieces) {
			fetch(this.url, opts)
				.then(async (response) => {
					const reader = response.body.getReader();

					while (true) {
						// Read data as it's received
						const { value, done } = await reader.read();
						const end = done || typeof value === 'undefined';

						if (!end) {
							// Buffer the data in it's proper location
							this.data.set(value, this.loaded);
							this.loaded += value.length;
						}

						// Fire pending request callbacks
						this.ready();

						if (done || !this._torrent) {
							this.controller = null;
							break;
						}
					}

					// Restart download for next uncached range
					this.download();
				})
				.catch((err) => {
					console.log(err);
				});
		}
	}

	// Fire pending request callbacks
	ready() {
		if (!this._torrent) {
			return;
		}

		const { pieceLength, length } = this._torrent;

		// For each pending chunk request, fire the callback
		// if the corresponding range of data has been loaded
		for (let key of Object.keys(this.queue)) {
			const index = parseInt(key);

			if (!this.queue[key]) {
				continue;
			}

			const s0 = index * pieceLength;
			const s1 = Math.min(s0 + pieceLength, length);

			if ((this.loaded || 0) >= s1) {
				this.queue[key](null, this.data.slice(s0, s1));

				delete this.queue[key];

				// Check if download has been flagged
				// for restart from new start index
				if (index === this.indexBreak) {
					this.indexBreak = null;
					this.controller.abort();
					this.controller = null;
					this.download();
				}
			}
		}
	}

	// Cleanup
	destroy() {
		super.destroy();

		if (this.controller && this._torrent) {
			this.controller.abort();
		}

		this._torrent = null;
	}
}
