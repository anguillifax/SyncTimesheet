// Synchronize Timesheet.jsx
// Version 1.0

(function (thisObj) {

	/////////////////////////////////////////////////////////////////////////////
	//                            LOADING PHASE                                //
	/////////////////////////////////////////////////////////////////////////////

	// ==========================================================================
	// Subphase 0: Load Settings
	// ==========================================================================

	function loadSettings() {
		var defaults = {
			timesheetFolder: './XDTS',
			inputFolder: 'Input',
			outputFolder: 'Comps',
			startFrame: 1,
			overrides: {},
		};

		function getSettingsFile() {
			var results = findInProject(
				function (x) { return x.name == 'xdts-sync.json' }
			);
			if (results.length > 1) {
				throw new Error('There can only be 1 `xdts-sync` file per project.');
			}
			if (results.length == 1) {
				return results[0];
			} else {
				return {};
			}
		}

		var custom = getSettingsFile();

		var combined = defaults;

		for (var key in custom) {
			combined[key] = custom[key];
		}

		validateSettingsObject(combined);

		return combined;
	}

	function validateSettingsObject(o) {
		function ensure(condition, info) {
			if (!condition) {
				throw new Error('Invalid settings file:\n' + info);
			}
		}

		ensure(typeof (o.timesheetFolder) == 'string', 'timesheetFolder is not string');
		ensure(typeof (o.inputFolder) == 'string', 'inputFolder is not string');
		ensure(typeof (o.outputFolder) == 'string', 'outputFolder is not string');
		ensure(typeof (o.startFrame) == 'number' && (o.startFrame == 0 || o.startFrame == 1), 'startFrame is not 0 or 1');
	}

	// ==========================================================================
	// Subphase 1: Read XDTS Files
	// ==========================================================================

	function readXdtsFiles(settings) {
		function getFileHandles() {
			if (app.project.file == null) {
				// Project has not been saved yet
				throw new Error('Project has not been saved. Save the project first before continuing.');
			}

			var searchFolder = app.project.file.parent;
			searchFolder.changePath(settings.timesheetFolder);

			if (!searchFolder.exists) {
				// No timesheet folder
				throw new Error('Could not find XDTS folder. Ensure that there is a folder named `XDTS` directly adjacent to the After Effects project file.\n\nFor advanced users, check the path `' + settings.timesheetFolder + '`.');
			}

			var files = searchFolder.getFiles('*.xdts');

			return files;
		}

		var files = getFileHandles();

		if (files.length == 0) {
			throw new Error('There are no XDTS files in the timesheet folder. No processing will occur.');
		}

		function readXdts(fileObj) {
			var fileName = File.decode(fileObj.name);

			if (!fileObj.open('r')) {
				// Could not open file
				throw new Error('Could not open Timesheet `' + fileName + '`.');
			}

			var contents = fileObj.read();
			var jsonBody = contents.substr('exchangeDigitalTimeSheet Save Data\n'.length);

			function checkWarn(value) {
				if (jsonBody.indexOf(value) != -1) {
					throw new Error('Warning, detected the value `' + value + '` within `' + fileName + '`. Due to technical limitations of ExtendScript, this value will result in processing errors.\n\nEnsure there are no columns with this name and update the XDTS files.');
				}
			}
			checkWarn('__proto__');
			checkWarn('prototype');
			checkWarn('toString');
			checkWarn('valueOf');

			var payload = parseJsonFromString(jsonBody);

			if (!fileObj.close()) {
				// Could not close file
				throw new Error('Could not close Timesheet `' + fileName + '`.');
			}

			return {
				name: fileName,
				payload: payload,
			};
		}

		var parsed = [];
		for (var i = 0; i < files.length; ++i) {
			parsed.push(readXdts(files[i]));
		}

		return parsed;
	}

	// ==========================================================================
	// Subphase 2: Locate Syncfolders
	// ==========================================================================

	function locateSyncFolders(settings, xdtsFiles) {
		function locate(name) {
			var result = getSubItem({
				predicate: function (x) { return x instanceof FolderItem && x.name == name },
				collection: app.project.items,
				onMissing: function () { throw new Error('Could not find sync folder with name `' + name + '`.') },
				onDuplicates: function () { throw new Error('Found too many sync folders with name `' + name + '`. Ensure there is only 1 sync folder with this name.') }
			});
			return result;
		}

		function generateMetadata(name, rootFolder, xdtsName) {
			var o = {
				name: name,
				xdtsName: xdtsName,
				root: rootFolder,
				inputs: null,
				outputs: null,
				cels: {},
				comps: {},
			};

			// Locate input folder
			o.inputs = getSubItem({
				predicate: function (x) { return x instanceof FolderItem && x.name == settings.inputFolder },
				collection: rootFolder,
				onMissing: function () { throw new Error('Could not find `' + settings.inputFolder + '` subfolder in `' + o.name + '`.') },
				onDuplicates: function () { throw new Error('Found duplicate `' + settings.inputFolder + '` subfolders in `' + o.name + '`. Ensure there are no duplicates.') }
			});

			// Locate output folder, allow reference to be null if not created yet
			o.outputs = getSubItem({
				predicate: function (x) { return x instanceof FolderItem && x.name == settings.outputFolder },
				collection: rootFolder,
				onMissing: function () { return null },
				onDuplicates: function () { throw new Error('Found duplicate `' + settings.outputFolder + '` subfolders in `' + o.name + '`. Ensure there are no duplicates.') }
			});

			// Create a map of cel names to cel footage
			var inItems = o.inputs.items;
			for (var i = 1; i <= inItems.length; ++i) {
				var cel = inItems[i];
				o.cels[cel.name] = cel;
			}

			// Create a map of comp names to comps, only run if output folder already exists
			if (o.outputs != null) {
				var outItems = o.outputs.items;
				for (var i = 1; i <= outItems.length; ++i) {
					var comp = outItems[i];
					o.comps[comp.name] = comp;
				}
			}

			return o;
		}

		var folders = [];
		for (var i = 0; i < xdtsFiles.length; ++i) {
			var expectedName = '[' + xdtsFiles[i].name + ']';
			var rootFolder = locate(expectedName);
			var entry = generateMetadata(expectedName, rootFolder, xdtsFiles[i].name);
			folders.push(entry);
		}

		return folders;
	}

	// ==========================================================================
	// Subphase 3: Parse Timesheets
	// ==========================================================================

	function parseTimesheets(settings, xdtsFiles) {
		function process(xdtsFile) {
			var timetable = xdtsFile.payload.timeTables[0];

			var timesheet = {
				name: xdtsFile.name,
				duration: timetable.duration,
				exposures: {},
				layers: [],
			};

			// XDTS Parsing Behavior

			function extractFields() {
				var result = [];

				var headers = timetable.timeTableHeaders;
				for (var i = 0; i < headers.length; ++i) {
					var header = headers[i];

					if (header.fieldId == 0) {
						result = header.names;
						break;
					}
				}

				var isWhitespaceRegex = /^\s*$/;
				for (var i = 0; i < result.length; ++i) {
					if (isWhitespaceRegex.test(result[i])) {
						throw new Error('Discovered an unnamed column in timesheet `' + xdtsFile.name + '`. Ensure all columns are given names with visible characters.');
					}
				}

				var sorted = result.concat();
				sorted.sort();
				for (var i = 0; i < sorted.length - 1; ++i) {
					if (sorted[i] == sorted[i + 1]) {
						throw new Error('Duplicate column name `' + sorted[i] + '` in timesheet `' + xdtsFile.name + '`. Remove duplicate column names and update the XDTS file.');
					}
				}

				return result;
			}

			function extractFrames() {
				var result = [];

				var fields = timetable.fields;
				for (var fieldIdx = 0; fieldIdx < fields.length; ++fieldIdx) {
					// Loops over each category of column data

					var entry = fields[fieldIdx];
					if (entry.fieldId != 0) {
						// Skip camera data and non-visible frames
						continue;
					}

					var tracks = entry.tracks;
					for (var trackNum = 0; trackNum < tracks.length; ++trackNum) {
						// Loop over each column

						var exposures = [];

						var frames = tracks[trackNum].frames;
						for (var i = 0; i < frames.length; ++i) {
							// Loops over all keys to gather exposure information

							var block = frames[i];
							var frameNum = block.frame;

							var dataChunk = block.data;
							for (var j = 0; j < dataChunk.length; ++j) {
								// Loop over each data type within frame

								var data = dataChunk[j];
								if (data.id != 0) {
									// Skip data not associated with exposed cel name
									continue;
								}

								// Extract the exposed cel number
								var rawValue = data.values[0];
								if (rawValue == 'SYMBOL_NULL_CELL') {
									exposures.push({ frame: frameNum, value: null });
								} else {
									var v = +rawValue;
									if (v == NaN) {
										throw new Error('Issue parsing frame data for `' + xdtsFile.name + '`, frame with value `' + rawValue + '` is not supported. Frames must be specified by number and hybrid notations such as `1 1a 2 2a` is not supported.\n\n' + err.message);
									}
									exposures.push({ frame: frameNum, value: v });
								}
							}
						}

						// Save column exposure data before moving on to next column
						result.push(exposures);
					}
				}

				return result;
			}

			function getExposures(allFields, allFrames) {
				var exposures = {};

				if (allFields.length != allFrames.length) {
					throw new Error('Mismatched column headers and column data, found ' + allFields.length + ' headers(s) and ' + allFrames.length + ' entries(s) in XDTS file `' + xdtsFile.name + '`.')
				}

				for (var i = 0; i < allFields.length; ++i) {
					exposures[allFields[i]] = allFrames[i];
				}

				return exposures;
			}

			// Finalize generating exposure information for single timesheet

			var allFields = extractFields();
			var allFrames = extractFrames();
			timesheet.exposures = getExposures(allFields, allFrames);
			timesheet.layers = allFields;

			return timesheet;
		}

		// Run processing action on each XDTS file
		var results = [];
		for (var i = 0; i < xdtsFiles.length; ++i) {
			results.push(process(xdtsFiles[i]));
		}
		return results;
	}

	// ==========================================================================
	// Subphase 4: Generate Tasks
	// ==========================================================================

	function generateTasks(settings, syncFolders, timesheets) {
		var tasks = [];

		function findTimesheetByName(name) {
			for (var i = 0; i < timesheets.length; ++i) {
				var timesheet = timesheets[i];
				if (timesheet.name == name) {
					return timesheet;
				}
			}
			throw new Error('Could not find timesheet with name `' + name + '` for task processing.');
		}

		function getColumnList(syncFolder, timesheet) {
			// Maps column name to relative display order
			var result = {};
			for (var i = 0; i < timesheet.layers.length; ++i) {
				var cname = timesheet.layers[i];
				if (syncFolder.cels[cname] != undefined) {
					result[cname] = i;
				}
			}
			return result;
		}

		for (var i = 0; i < syncFolders.length; ++i) {
			var syncFolder = syncFolders[i];
			var cleanName = syncFolder.xdtsName;
			var timesheet = findTimesheetByName(cleanName);
			var columns = getColumnList(syncFolder, timesheet);
			tasks.push({
				name: cleanName,
				syncFolder: syncFolders[i],
				timesheet: timesheet,
				columns: columns,
			});
		}

		return tasks;
	}

	/////////////////////////////////////////////////////////////////////////////
	//                              APPLY PHASE                                //
	/////////////////////////////////////////////////////////////////////////////

	// ==========================================================================
	// Subphase 0: Populate Missing Files
	// ==========================================================================

	function populateMissingFiles(settings, tasks) {
		var COMP_DEFAULTS = {
			width: 100,
			height: 100,
			pixelAspect: 1,
			duration: 10,
			frameRate: 24,
		};

		function process(folder, timesheet, columns) {
			// Create output folder if missing
			if (folder.outputs == null) {
				folder.outputs = folder.root.items.addFolder(settings.outputFolder);
			}

			// Create missing comps using stubbed values
			for (var cname in columns) {
				if (folder.comps[cname] == undefined) {
					folder.comps[cname] = folder.outputs.items.addComp(
						cname,
						COMP_DEFAULTS.width,
						COMP_DEFAULTS.height,
						COMP_DEFAULTS.pixelAspect,
						COMP_DEFAULTS.duration,
						COMP_DEFAULTS.frameRate
					);
				}
			}
		}

		for (var i = 0; i < tasks.length; ++i) {
			var task = tasks[i];
			process(task.syncFolder, task.timesheet, task.columns);
		}
	}

	// ==========================================================================
	// Subphase 1: Fix Cel Settings
	// ==========================================================================

	function fixCelSettings(settings, tasks) {
		function process(folder, timesheet, columns) {
			for (var cname in columns) {
				var cel = folder.cels[cname];

				// Ensure cel is long enough to cover entire timesheet for timewarp purposes
				cel.mainSource.loop = timesheet.duration;

				// TODO: Check if the underlying image files have changed and reimport
			}
		}

		for (var i = 0; i < tasks.length; ++i) {
			var task = tasks[i];
			process(task.syncFolder, task.timesheet, task.columns);
		}
	}

	// ==========================================================================
	// Subphase 2: Fix Comp Settings
	// ==========================================================================

	function fixCompSettings(settings, tasks) {
		function process(folder, timesheet, columns) {
			for (var cname in columns) {
				var comp = folder.comps[cname];
				var cel = folder.cels[cname];

				// Match comp settings with original cel
				comp.width = cel.width;
				comp.height = cel.height;
				comp.pixelAspect = cel.pixelAspect;
				comp.duration = timesheet.duration / cel.frameRate;
				comp.frameRate = cel.frameRate;

				// Remove existing layers
				var layersToDelete = comp.numLayers;
				for (var i = 0; i < layersToDelete; ++i) {
					comp.layer(1).remove();
				}

				// Add associated cel
				var celLayer = comp.layers.add(cel);

				// Expand cel to cover composition duration
				celLayer.startTime = 0;
				celLayer.inPoint = 0;
				celLayer.outPoint = timesheet.duration / cel.frameRate;
			}
		}

		for (var i = 0; i < tasks.length; ++i) {
			var task = tasks[i];
			process(task.syncFolder, task.timesheet, task.columns);
		}
	}

	// ==========================================================================
	// Subphase 3: Retime Comps
	// ==========================================================================

	function retimeComps(settings, tasks) {
		function process(folder, timesheet, columns) {
			for (var cname in columns) {
				var comp = folder.comps[cname];
				var layer = comp.layer(1);
				var exposures = timesheet.exposures[cname];

				// Add timewarp effect
				var timewarp = layer.effect.addProperty('Timewarp')
				timewarp.method.setValue(1); // 1 = Whole Frames
				timewarp.adjustTimeBy.setValue(2); // 2 = Source Frame

				// Set timewarp keys using default interpolation
				function setTimewarpKeys(prop) {
					var times = [];
					var values = []

					for (var i = 0; i < exposures.length; ++i) {
						var entry = exposures[i];
						times.push(entry.frame / comp.frameRate);

						// If the cel is hidden, set the source frame to -1 to indicate the
						// absence of data.
						//
						// If the cel is visible, remap the 1-indexed cel numbers to the
						// 0-indexed source frame values.
						values.push(entry.value == null ? -1 : entry.value - 1);
					}

					prop.setValuesAtTimes(times, values);
				}
				setTimewarpKeys(timewarp.sourceFrame);

				// Set opacity keys using default interpolation
				function setOpacityKeys(prop) {
					var times = [];
					var values = [];

					if (exposures.length == 0 || exposures[0].frame > 0) {
						// If there are no visible frames, ensure the layer is hidden.
						//
						// If the column becomes visible later than the first frame, ensure
						// it starts hidden.
						//
						// If the column has negative frames and includes timing outside
						// the visible range, rely on the negative initial key to set the
						// starting opacity.
						times.push(0);
						values.push(0);
					}

					for (var i = 0; i < exposures.length; ++i) {
						var entry = exposures[i];
						times.push(entry.frame / comp.frameRate);
						values.push(entry.value == null ? 0 : 100);
					}

					prop.setValuesAtTimes(times, values);
				}
				var opacity = layer.transform.opacity;
				setOpacityKeys(opacity);

				// Convert all keys to hold type
				function convertToHoldType(property) {
					var holdType = KeyframeInterpolationType.HOLD;
					for (var i = 1; i <= property.numKeys; ++i) {
						property.setInterpolationTypeAtKey(i, holdType, holdType);
					}
				}
				convertToHoldType(timewarp.sourceFrame);
				convertToHoldType(opacity);
			}
		}

		for (var i = 0; i < tasks.length; ++i) {
			var task = tasks[i];
			process(task.syncFolder, task.timesheet, task.columns);
		}
	}

	/////////////////////////////////////////////////////////////////////////////
	//                                  MAIN                                   //
	/////////////////////////////////////////////////////////////////////////////

	function main() {
		clearOutput();
		var hasUndo = false;

		try {
			// Load Phase
			var settings = loadSettings();
			var xdtsFiles = readXdtsFiles(settings);
			var syncFolders = locateSyncFolders(settings, xdtsFiles);
			var timesheets = parseTimesheets(settings, xdtsFiles);
			var tasks = generateTasks(settings, syncFolders, timesheets);

			// Apply Phase
			app.beginUndoGroup('Synchronize Timesheets');
			hasUndo = true;
			populateMissingFiles(settings, tasks);
			fixCelSettings(settings, tasks);
			fixCompSettings(settings, tasks);
			retimeComps(settings, tasks);
			app.endUndoGroup();

		} catch (err) {
			if (hasUndo) {
				app.endUndoGroup();
			}
			alert(err.message);
		}
	}

	/////////////////////////////////////////////////////////////////////////////
	//                              UTILITIES                                  //
	/////////////////////////////////////////////////////////////////////////////

	// ==========================================================================
	// Searching
	// ==========================================================================

	function findInProject(predicate) {
		var items = app.project.items;
		var results = [];

		for (var i = 1; i <= items.length; ++i) {
			var o = items[i];
			if (predicate(o)) {
				results.push(o);
			}
		}

		return results;
	}

	function getSubItem(context) {
		var predicate = context.predicate;
		var collection = context.collection;
		var onMissing = context.onMissing;
		var onDuplicates = context.onDuplicates;

		if (predicate == undefined) {
			throw new Error('Missing predicate for getSubItem()');
		}
		if (collection == undefined) {
			throw new Error('Missing collection for getSubItem()');
		}
		if (!(collection instanceof FolderItem || collection instanceof ItemCollection)) {
			throw new Error('Not a folder or item collection for getSubItem()');
		}

		var results = [];
		var items = collection instanceof FolderItem ? collection.items : collection;

		for (var i = 1; i <= items.length; ++i) {
			var o = items[i];
			if (predicate(o)) {
				results.push(o);
			}
		}

		if (results.length == 0) {
			if (onMissing == undefined) {
				throw new Error('Could not find item inside of parent folder `' + collection.name + '`.');
			} else {
				return onMissing();
			}
		}

		if (results.length > 1) {
			if (onDuplicates == undefined) {
				throw new Error('Found too many copies of item inside of parent folder `' + collection.name + '`. Ensure there is only one copy.');
			} else {
				return onDuplicates();
			}
		}

		return results[0];
	}

	function findInArray(predicate, array, onMissing) {
		for (var i = 0; i < array.length; ++i) {
			var o = array[i];
			if (predicate(o)) {
				return o;
			}
		}
		if (onMissing == undefined) {
			throw new Error('Could not find item in array');
		} else {
			return onMissing();
		}
	}

	// ==========================================================================
	// JSON Processing
	// ==========================================================================

	function parseJsonFromString(jsonString) {
		return (new Function("return " + jsonString))();
	}

	// ==========================================================================
	// Printing
	// ==========================================================================

	function print(header, body) {
		var content = body == null ? '(null)' : body.toString();
		alert(header + '\n' + content);
	}

	/////////////////////////////////////////////////////////////////////////////
	//                       MAIN ENTRYPOINT                                   //
	/////////////////////////////////////////////////////////////////////////////

	main();

})(this);