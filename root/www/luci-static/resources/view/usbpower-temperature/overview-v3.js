'use strict';
'require view';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';

var CONFIG = 'usbpower_temperature';
var SECTION = 'settings';
var DAEMON = '/usr/sbin/usbpowerd';
var CTL = '/usr/sbin/usbpower-temperature-ctl';
var INIT = '/etc/init.d/usbpower_temperature';
var STATUS_CACHE = '/tmp/usbpowerd.status.json';
var VERSION = '1.3.2';

function execJSON(command, args) {
	return fs.exec(command, args || []).then(function(res) {
		if (res.code !== 0)
			throw new Error((res.stderr || '').trim() || ('exit code ' + res.code));

		return JSON.parse(res.stdout);
	});
}

function readStatus() {
	return fs.exec(DAEMON, [ 'status-json' ]).then(function(res) {
		if (res.code !== 0)
			throw new Error((res.stderr || '').trim() || ('exit code ' + res.code));

		return JSON.parse(res.stdout);
	}).catch(function(execError) {
		return fs.read(STATUS_CACHE).then(function(text) {
			return JSON.parse(text);
		}).catch(function(readError) {
			throw new Error(
				(execError && execError.message ? execError.message : String(execError)) +
				' / ' + (readError && readError.message ? readError.message : String(readError))
			);
		});
	});
}

function notifyError(err) {
	ui.addNotification(null, E('p', {}, err && err.message ? err.message : String(err)), 'danger');
}

function tempText(value) {
	if (value == null || value < 0)
		return _('Unknown');

	return Number(value).toFixed(1) + ' °C';
}

function stateText(value) {
	if (value === 'on')
		return _('Powered');
	if (value === 'off')
		return _('Unpowered');

	return _('Unknown');
}

function reasonText(reason) {
	if (reason && reason.indexOf('temperature=') === 0)
		return _('Temperature') + ' ' + reason.substring(12) + ' °C';
	if (reason === 'startup')
		return _('Startup');
	if (reason === 'sensor_error')
		return _('Sensor error');

	return reason || '-';
}

function formatLogs(entries) {
	if (!Array.isArray(entries) || !entries.length)
		return _('No log entries yet.');

	return entries.slice().reverse().map(function(entry) {
		var when = entry.ts ? new Date(entry.ts * 1000).toLocaleString() : '';

		return (when ? when + '  ' : '') + (entry.msg || '');
	}).join('\n');
}

function statusItem(label) {
	var value = E('span', { 'class': 'usbpower-status-value' }, '-');

	return {
		node: E('div', { 'class': 'usbpower-status-item', 'style': 'display:flex;flex-direction:column;gap:2px' }, [
			E('span', { 'class': 'usbpower-status-label', 'style': 'font-size:85%;opacity:.75' }, label),
			value
		]),
		value: value
	};
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load(CONFIG),
			readStatus().catch(function() {
				return null;
			}),
			execJSON(DAEMON, [ 'detect' ]).catch(function() {
				return { targets: [], sensors: [] };
			})
		]);
	},

	refreshStatus: function(refs) {
		return readStatus().then(L.bind(function(status) {
			refs.statusError.style.display = 'none';
			refs.temp.value.textContent = tempText(status.temp);
			refs.power.value.textContent = stateText(status.state);
			refs.power.value.style.color = status.state === 'on'
				? '#2e7d32'
				: (status.state === 'off' ? '#c62828' : '');
			refs.backend.value.textContent = status.target || status.backend || '-';
			refs.running.value.textContent = status.running ? _('Service running') : _('Service stopped');
			refs.last.value.textContent = status.last_change
				? new Date(status.last_change * 1000).toLocaleString()
				: '-';
			refs.guardNote.style.display = status.guard ? '' : 'none';
			refs.configuredNote.style.display = status.configured ? 'none' : '';
			refs.errorNote.style.display = status.sensor_ok ? 'none' : '';

			try {
				refs.log.textContent = formatLogs(status.logs);
				refs.log.scrollTop = 0;
			}
			catch (err) {
				console.error('usbpower log rendering failed:', err);
				refs.statusError.textContent = _('History or log rendering failed: %s').format(err.message || err);
				refs.statusError.style.display = '';
			}

			try {
				this.refreshHistory(refs.historyBody, status.history);
			}
			catch (err) {
				console.error('usbpower history rendering failed:', err);
				refs.statusError.textContent = _('History or log rendering failed: %s').format(err.message || err);
				refs.statusError.style.display = '';
			}
		}, this)).catch(L.bind(function(err) {
			console.error('usbpower status request failed:', err);
			refs.running.value.textContent = _('Service unavailable');
			refs.statusError.textContent = _('Status request failed: %s').format(err.message || err) +
				' ' + _('Reload the page and log in again if the problem persists.');
			refs.statusError.style.display = '';
		}, this));
	},

	refreshHistory: function(tbody, history) {
		var rows = Array.isArray(history) ? history.slice().reverse() : [];

		while (tbody.firstChild)
			tbody.removeChild(tbody.firstChild);

		if (!rows.length) {
			tbody.appendChild(E('tr', {}, [
				E('td', { 'colspan': 4 }, E('em', {}, _('No switching events yet.')))
			]));
			return;
		}

		rows.forEach(function(event) {
			var when = event.ts ? new Date(event.ts * 1000).toLocaleString() : '-';

			tbody.appendChild(E('tr', {}, [
				E('td', {}, when),
				E('td', {}, stateText(event.state)),
				E('td', {}, reasonText(event.reason)),
				E('td', {}, tempText(event.temp))
			]));
		});
	},

	manual: function(action) {
		var self = this;

		return fs.exec(CTL, [ action ]).then(function(res) {
			if (res.code !== 0)
				throw new Error((res.stderr || '').trim() || ('exit code ' + res.code));

			window.setTimeout(function() {
				location.reload();
			}, 1500);
		}).catch(notifyError);
	},

	applyTarget: function(target) {
		uci.set(CONFIG, SECTION, 'backend', target.backend);

		if (target.backend === 'gpio')
			uci.set(CONFIG, SECTION, 'gpio_path', target.path || '');
		else if (target.backend === 'regulator')
			uci.set(CONFIG, SECTION, 'regulator_path', target.path || '');
		else if (target.backend === 'uhubctl') {
			uci.set(CONFIG, SECTION, 'uhubctl_location', target.location || '');
			uci.set(CONFIG, SECTION, 'uhubctl_port', String(target.port || ''));
		}

		return uci.save()
			.then(function() { return uci.apply(); })
			.then(function() { return fs.exec(INIT, [ 'restart' ]); })
			.then(function() {
				window.setTimeout(function() {
					location.reload();
				}, 1500);
			})
			.catch(notifyError);
	},

	applySensor: function(sensor) {
		uci.set(CONFIG, SECTION, 'sensor', sensor.path);
		uci.set(CONFIG, SECTION, 'sensor_divisor', '1000');

		return uci.save()
			.then(function() { return uci.apply(); })
			.then(function() { return fs.exec(INIT, [ 'restart' ]); })
			.then(function() {
				window.setTimeout(function() {
					location.reload();
				}, 1500);
			})
			.catch(notifyError);
	},

	fillDetection: function(container, data) {
		while (container.firstChild)
			container.removeChild(container.firstChild);

		var targets = (data && data.targets) || [];
		var sensors = (data && data.sensors) || [];

		container.appendChild(E('h4', {}, _('Detected control targets')));
		if (!targets.length) {
			container.appendChild(E('p', {}, _('No usable control target was detected. Fill in the matching fields below manually.')));
		}
		else {
			targets.forEach(L.bind(function(target) {
				container.appendChild(E('div', { 'class': 'usbpower-detect-row' }, [
					E('code', {}, target.label || (target.backend + ' ' + (target.path || ''))),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': L.bind(this.applyTarget, this, target)
					}, _('Use this'))
				]));
			}, this));
		}

		container.appendChild(E('h4', {}, _('Detected temperature sensors')));
		if (!sensors.length) {
			container.appendChild(E('p', {}, _('No temperature sensor was detected. Enter the sensor path manually.')));
		}
		else {
			sensors.forEach(L.bind(function(sensor) {
				container.appendChild(E('div', { 'class': 'usbpower-detect-row' }, [
					E('code', {}, sensor.path + ' (' + (sensor.type || '?') + ', ' + tempText(sensor.temp) + ')'),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': L.bind(this.applySensor, this, sensor)
					}, _('Use this'))
				]));
			}, this));
		}
	},

	render: function(data) {
		var status = data[1];
		var detected = data[2] || { targets: [], sensors: [] };
		var refs = {};
		var m, s, o;

		refs.power = statusItem(_('USB power'));
		refs.power.value.style.fontWeight = 'bold';
		refs.power.value.style.fontSize = '1.15em';
		refs.temp = statusItem(_('SoC temperature'));
		refs.backend = statusItem(_('Power target'));
		refs.running = statusItem(_('Service state'));
		refs.last = statusItem(_('Last change'));
		refs.historyBody = E('tbody', {});
		refs.log = E('pre', {
			'style': 'max-height:20em;overflow:auto;white-space:pre-wrap;margin:0'
		}, '-');

		refs.guardNote = E('p', {
			'class': 'alert-message warning',
			'style': 'display:none'
		}, _('A mounted storage device was detected; automatic power-off is blocked.'));

		refs.configuredNote = E('p', {
			'class': 'alert-message warning',
			'style': 'display:none'
		}, _('No valid control target is configured, so the service will not start. Use the detection results or fill in the fields manually.'));

		refs.errorNote = E('p', {
			'class': 'alert-message warning',
			'style': 'display:none'
		}, _('Temperature sensor read failed; automatic mode will force power on.'));

		refs.statusError = E('p', {
			'class': 'alert-message warning',
			'style': 'display:none'
		});

		var statusBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Current status')),
			E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:.5em;margin:.5em 0' }, [
				refs.power.node,
				refs.temp.node,
				refs.backend.node,
				refs.running.node,
				refs.last.node
			]),
			refs.guardNote,
			refs.configuredNote,
			refs.errorNote,
			refs.statusError,
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': L.bind(this.manual, this, 'on')
				}, _('Power on now')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-reset',
					'click': L.bind(this.manual, this, 'off')
				}, _('Power off now')),
				' ',
				E('button', {
					'class': 'btn cbi-button',
					'click': L.bind(this.manual, this, 'auto')
				}, _('Resume automatic'))
			])
		]);

		var detectionList = E('div', {});
		var detectionBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Hardware detection')),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': L.bind(function() {
						return execJSON(DAEMON, [ 'detect' ])
							.then(L.bind(this.fillDetection, this, detectionList))
							.catch(notifyError);
					}, this)
				}, _('Detect again'))
			]),
			detectionList
		]);

		var historyBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Recent switches')),
			E('table', { 'class': 'table' }, [
				E('thead', {}, [
					E('tr', {}, [
						E('th', {}, _('Time')),
						E('th', {}, _('Switch action')),
						E('th', {}, _('Reason')),
						E('th', {}, _('Temperature'))
					])
				]),
				refs.historyBody
			])
		]);

		var logBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Recent log')),
			refs.log
		]);

		m = new form.Map(CONFIG, _('USB Thermal Fan'),
			_('Automatically control the power of the selected USB port based on the SoC temperature. A minimum dwell time prevents frequent switching.') +
			' (v' + VERSION + ')');

		s = m.section(form.NamedSection, SECTION, 'settings', _('Settings'));

		o = s.option(form.Flag, 'enabled', _('Enable service'));
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.ListValue, 'mode', _('Thermal mode'));
		o.value('auto', _('Automatic (by temperature)'));
		o.value('always_on', _('Always on'));
		o.value('always_off', _('Always off'));

		o = s.option(form.ListValue, 'backend', _('Control method'),
			_('Select how this USB port power is actually switched. Use "Detect again" below to find candidates first.'));
		o.value('gpio', _('sysfs GPIO'));
		o.value('uhubctl', 'uhubctl');
		o.value('regulator', _('regulator sysfs'));
		o.value('command', _('Custom command'));

		o = s.option(form.Value, 'gpio_path', _('GPIO value path'));
		o.depends('backend', 'gpio');
		o.placeholder = '/sys/class/gpio/usb_power/value';
		o.rmempty = true;

		o = s.option(form.Value, 'uhubctl_location', _('uhubctl location (-l)'));
		o.depends('backend', 'uhubctl');
		o.placeholder = '1-1';
		o.rmempty = true;

		o = s.option(form.Value, 'uhubctl_port', _('uhubctl port (-p)'));
		o.depends('backend', 'uhubctl');
		o.datatype = 'uinteger';
		o.default = '1';
		o.rmempty = true;

		o = s.option(form.Value, 'regulator_path', _('regulator state path'));
		o.depends('backend', 'regulator');
		o.placeholder = '/sys/class/regulator/regulator.0/state';
		o.rmempty = true;

		o = s.option(form.Value, 'command_on', _('Power-on command'));
		o.depends('backend', 'command');
		o.placeholder = 'echo 1 > /path/to/switch';
		o.rmempty = true;

		o = s.option(form.Value, 'command_off', _('Power-off command'));
		o.depends('backend', 'command');
		o.placeholder = 'echo 0 > /path/to/switch';
		o.rmempty = true;

		o = s.option(form.Value, 'command_state', _('Optional state command'));
		o.depends('backend', 'command');
		o.description = _('The command must output 1 when powered and 0 when off; leave empty to show the state as unknown.');
		o.rmempty = true;

		o = s.option(form.Value, 'sensor', _('Temperature sensor path'));
		o.default = '/sys/class/thermal/thermal_zone0/temp';
		o.rmempty = false;

		o = s.option(form.Value, 'sensor_divisor', _('Temperature divisor'),
			_('The raw sysfs value is divided by this number to get degrees Celsius, usually 1000.'));
		o.datatype = 'uinteger';
		o.default = '1000';
		o.rmempty = false;

		o = s.option(form.Value, 'on_threshold', _('Power-on threshold (°C)'),
			_('Power on when the temperature is above this value.'));
		o.datatype = 'uinteger';
		o.default = '65';
		o.rmempty = false;

		o = s.option(form.Value, 'off_threshold', _('Power-off threshold (°C)'),
			_('Power off when the temperature is at or below this value; it must be lower than the power-on threshold.'));
		o.datatype = 'uinteger';
		o.default = '60';
		o.rmempty = false;

		o = s.option(form.Value, 'poll_interval', _('Poll interval (seconds)'));
		o.datatype = 'uinteger';
		o.default = '10';
		o.rmempty = false;

		o = s.option(form.Value, 'min_on_time', _('Minimum on time (seconds)'));
		o.datatype = 'uinteger';
		o.default = '300';
		o.rmempty = false;

		o = s.option(form.Value, 'min_off_time', _('Minimum off time (seconds)'));
		o.datatype = 'uinteger';
		o.default = '120';
		o.rmempty = false;

		o = s.option(form.Flag, 'storage_guard', _('Storage guard'),
			_('Refuse automatic or manual power-off while a /dev/sd* storage is mounted.'));
		o.default = '1';
		o.rmempty = false;

		return m.render().then(L.bind(function(nodes) {
			nodes.insertBefore(statusBox, nodes.firstChild);
			nodes.appendChild(detectionBox);
			nodes.appendChild(historyBox);
			nodes.appendChild(logBox);
			this.fillDetection(detectionList, detected);
			poll.add(L.bind(this.refreshStatus, this, refs), 5);
			this.refreshStatus(refs);
			return nodes;
		}, this));
	},

	handleSaveApply: function(ev, mode) {
		return this.handleSave(ev).then(function() {
			return ui.changes.apply(mode == '0');
		}).then(function() {
			return fs.exec(DAEMON, [ 'check' ]);
		}).then(function(res) {
			if (res.code !== 0)
				throw new Error((res.stderr || '').trim() || _('Invalid configuration'));
			return fs.exec(INIT, [ 'enable' ]);
		}).then(function() {
			return fs.exec(INIT, [ 'restart' ]);
		}).then(function(res) {
			if (res.code !== 0)
				throw new Error((res.stderr || '').trim() || _('Failed to restart the service'));
		}).catch(notifyError);
	}
});
