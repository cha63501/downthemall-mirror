var sessionManager = {

	init: function() {
		this._con = Cc["@mozilla.org/storage/service;1"]
			.getService(Ci.mozIStorageService)
			.openDatabase(DTA_profileFile.get('dta_queue.sqlite'));
		try {
			this._con.executeSimpleSQL('CREATE TABLE queue (uuid INTEGER PRIMARY KEY AUTOINCREMENT, pos INTEGER, item TEXT)');
		} catch (ex) {
			// no-op
		}
		this._saveStmt = this._con.createStatement('REPLACE INTO queue (uuid, pos, item) VALUES (?1, ?2, ?3)');
		this._delStmt = this._con.createStatement('DELETE FROM queue WHERE uuid = ?1');

		this._converter = Components.classes["@mozilla.org/intl/saveascharset;1"]
			.createInstance(Ci.nsISaveAsCharset);
		this._converter.Init('utf-8', 1, 0);
		this._serializer = new XMLSerializer();

		this.load();
	},

	_saveDownload: function(d, pos) {

		if (!(
			(!Prefs.removeCompleted && d.isCompleted) ||
			(!Prefs.removeCanceled && d.isCanceled) ||
			(!Prefs.removeAborted && !d.isStarted) ||
			d.isPaused ||
			d.setIsRunning())
		) {
			return;
		}
		var e = {};
		[
			'fileName',
			'destinationName',
			'numIstance',
			'description',
			'isResumable',
			'alreadyMaskedName',
			'alreadyMaskedDir',
			'mask',
			'originalDirSave',
			'isCompleted',
			'isCanceled'
		].forEach(function(u) { e[u] = d[u]; });

		e.dirsave = d.dirSave.addFinalSlash();
		e.referrer = d.refPage.spec;
		e.startDate = d.startDate.toUTCString();

		e.urlManager = d.urlManager.save();
		e.visitors = d.visitors.save();

		if (!d.isResumable && !d.isCompleted) {
			e.partialSize = 0;
			e.totalSize = 0;
		} else {
			e.partialSize = d.partialSize;
			e.totalSize = d.totalSize;
		}

		e.chunks = [];

		if (!d.isCanceled && !d.isCompleted && d.chunks.length > 0) {
			var x = d.firstChunk;
			do {
				if (!d.chunks[x].isRunning && d.chunks[x].chunkSize != 0) {
					var chunk = {};
					chunk.path = d.chunks[x].fileManager.path;
					chunk.start = d.chunks[x].start;
					chunk.end = d.chunks[x].end;
					chunk.size = d.chunks[x].chunkSize;
					e.chunks.push(chunk);
				}
				x = d.chunks[x].next;
			} while(x != -1);
		}

		var s = this._saveStmt;
		if (d.dbID) {
			s.bindInt64Parameter(0, d.dbID);
		}
		else {
			s.bindNullParameter(0);
		}
		s.bindInt32Parameter(1, pos);
		s.bindUTF8StringParameter(2, this._converter.Convert(e.toSource()));
		s.execute();
		d.dbID = this._con.lastInsertRowID;
	},

	beginUpdate: function() {
		this._con.beginTransactionAs(this._con.TRANSACTION_DEFERRED);		
	},
	endUpdate: function() {
		this._con.commitTransaction();
	},	
	save: function(download) {

		// just one download.
		if (download) {
			this._saveDownload(download);
			return;
		}

		this.beginUpdate();
		try {
			this._con.executeSimpleSQL('DELETE FROM queue');
			downloadList.forEach(
				function(e, i) {
					this._saveDownload(e, i);
				},
				this
			);
		}
		catch (ex) {
			Debug.dump(ex);
		}
		this.endUpdate();

	},
	deleteDownload: function(download) {
		if (!download.dbID) {
			return;
		}
		this._delStmt.bindInt64Parameter(0, download.dbID);
		this._delStmt.execute();
	},

	load: function() {

		const removeCompleted = Prefs.removeCompleted;
		const removeCanceled = Prefs.removeCompleted;

		var stmt = this._con.createStatement('SELECT uuid, item FROM queue ORDER BY pos');

		while (stmt.executeStep()) {
			try {
				const dbID = stmt.getInt64(0);
				var down = eval(stmt.getUTF8String(1));
				var get = function(attr) {
					if (attr in down) {
						return down[attr];
					}
					return null;
				}
				if (
					(removeCompleted && down.completed)
					|| (removeCanceled && down.canceled)
				) {
					continue;
				}

				var d = new downloadElement(
					new DTA_URLManager(down.urlManager),
					get("dirsave"),
					get("numIstance"),
					get("description"),
					get("mask"),
					get("referrer")
					);
				d.dbID = dbID;
				d.startDate = new Date(get("startDate"));
				d.visitors.load(down.visitors);

				[
					'fileName',
					'destinationName',
					'orginalDirSave',
					'isResumable',
					'isCanceled',
					'isCompleted',
					'partialSize',
					'totalSize',
					'alreadyMaskedName',
					'alreadyMaskedDir',
				].forEach(
					function(e) {
						d[e] = get(e);
					}
				);

				d.isStarted = d.partialSize != 0;

				if (!d.isCanceled && !d.isCompleted) {
					d.isPaused = true;
					var chunks = down.chunks;
					for (var i = 0, e = chunks.length; i < e; ++i) {
						var c = chunks[i];
						var test = new FileFactory(c.path);
						if (test.exists()) {
							var i = d.chunks.length;
							d.chunks.push(
								new chunkElement(
									c.start,
									c.start + c.size - 1,
									d
								)
							);
							d.chunks[i].isRunning = false;
							d.chunks[i].chunkSize = c.size;

							d.chunks[i].previous = i - 1;
							// adjusted below.
							d.chunks[i].next = i + 1;

							d.chunks[i].fileManager = test;
						}
						else if (d.chunks.length == 1) {
							// only finished chunks get saved.
							// one missing therefore means it already got joined
							d.chunks[0].chunkSize += c.size;
							d.chunks[0].end += c.size;
							Debug.dump("sessionManager::load: missing chunk");
						}
					}
					d.refreshPartialSize();

					if (d.chunks.length > 0) {
						// adjust the end.
						d.chunks[d.chunks.length - 1].next = -1;
						d.join = new joinListener(d);
					}

				}
				else if (d.isCompleted) {
					d.fileManager = new FileFactory(d.dirSave);
					d.fileManager.append(d.destinationName);
					Stats.completedDownloads++;
					d.isPassed = true;
				}
				else if (d.isCanceled) {
					d.isPassed = true;
				}

				downloadList.push(d);
				populateListbox(d);
			}
			catch (ex) {
				Debug.dump('failed to init a download from queuefile', ex);
			}
		}
	}
};