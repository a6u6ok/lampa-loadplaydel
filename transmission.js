
(function () {
    'use strict';

    /*
     * Lampa qBittorrent Player add-on
     * Load AFTER the qBittorrent/Transdroid plugin.
     *
     * Example:
     * qBittorrent root: D:\Torrents
     * SMB root: smb://192.168.1.10/Torrents
     */

    var KEY_SMB = 'qbit_player_smb_root';
    var KEY_QBROOT = 'qbit_player_qb_root';
    var KEY_ENABLED = 'qbit_player_enabled';
    var POLL_MS = 5000;
    var REQUEST_TIMEOUT_MS = 5000;
    var VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|ogv|3gp|flv|vob)$/i;
    var STYLE_ID = 'qbit-player-addon-style';
    var initialized = false;
    var tracked = {};

    function storageGet(key, fallback) {
        try {
            var value = window.Lampa && Lampa.Storage
                ? Lampa.Storage.get(key, fallback)
                : fallback;
            return value === undefined || value === null ? fallback : value;
        } catch (e) {
            return fallback;
        }
    }

    function notify(message) {
        try {
            if (window.Lampa && Lampa.Noty &&
                typeof Lampa.Noty.show === 'function') {
                Lampa.Noty.show(message);
            } else {
                console.log('[qB Player] ' + message);
            }
        } catch (e) {
            console.log('[qB Player] ' + message);
        }
    }

    function config() {
        var smb = String(storageGet(KEY_SMB, '') || '')
            .trim().replace(/\/+$/, '');

        return {
            apiUrl: String(
                storageGet('qbit_url', 'http://192.168.1.50:8080') || ''
            ).trim().replace(/\/+$/, ''),

            user: String(storageGet('qbit_user', '') || ''),
            pass: String(storageGet('qbit_pass', '') || ''),

            bypass: storageGet('qbit_bypass', true) === true ||
                storageGet('qbit_bypass', true) === 'true',

            enabled: storageGet(KEY_ENABLED, true) !== false &&
                storageGet(KEY_ENABLED, true) !== 'false',

            smbRoot: smb ? smb + '/' : '',

            qbRoot: String(storageGet(KEY_QBROOT, '') || '')
                .trim().replace(/[\\/]+$/, '')
        };
    }

    function parseJSON(value) {
        if (typeof value !== 'string') {
            return value && typeof value === 'object' ? value : null;
        }

        try {
            return JSON.parse(value);
        } catch (e) {
            return null;
        }
    }

    function encodePath(path) {
        return String(path || '').split('/').map(function (part) {
            return encodeURIComponent(part).replace(/%3A/ig, ':');
        }).join('/');
    }

    function normalizeFsPath(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
    }

    function relativeToRoot(path, root) {
        var normalizedPath = normalizeFsPath(path);
        var normalizedRoot = normalizeFsPath(root);

        if (!normalizedRoot) {
            return normalizedPath.replace(/^\/+/, '');
        }

        var p = normalizedPath.toLowerCase();
        var r = normalizedRoot.toLowerCase();

        if (p === r) return '';

        if (p.indexOf(r + '/') === 0) {
            return normalizedPath
                .substring(normalizedRoot.length)
                .replace(/^\/+/, '');
        }

        return null;
    }

    /*
     * HTTP requests through the Lampa AndroidJS bridge.
     * Browser fetch is used as a fallback.
     */
    function request(options, callback) {
        var finished = false;
        var timer = null;

        function done(value) {
            if (finished) return;

            finished = true;

            if (timer) clearTimeout(timer);

            callback(value);
        }

        timer = setTimeout(function () {
            done(null);
        }, REQUEST_TIMEOUT_MS);

        if (window.AndroidJS &&
            typeof window.AndroidJS.httpReq === 'function') {

            try {
                try {
                    window.AndroidJS.getResp();
                } catch (ignore) {}

                window.AndroidJS.httpReq(JSON.stringify({
                    url: options.url,
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    body: options.body || ''
                }));

                var attempts = 0;

                (function pollResponse() {
                    if (finished) return;

                    var response = null;

                    try {
                        response = window.AndroidJS.getResp();
                    } catch (e) {}

                    if (typeof response === 'string' &&
                        response.length) {

                        done(response);

                    } else if (++attempts >= 30) {

                        done(null);

                    } else {

                        setTimeout(pollResponse, 150);
                    }
                })();

                return;

            } catch (e) {
                // Try fetch below.
            }
        }

        if (typeof fetch !== 'function') {
            return done(null);
        }

        var fetchOptions = {
            method: options.method || 'GET',
            headers: options.headers || {},
            credentials: 'include'
        };

        if (options.body) {
            fetchOptions.body = options.body;
        }

        fetch(options.url, fetchOptions)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                return response.text();
            })
            .then(done)
            .catch(function () {
                done(null);
            });
    }

    function api(path, callback) {
        var c = config();

        if (!c.apiUrl) return callback(null);

        function getData() {
            request({
                url: c.apiUrl + path,
                method: 'GET'
            }, callback);
        }

        if (!c.bypass && c.user) {
            request({
                url: c.apiUrl + '/api/v2/auth/login',
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/x-www-form-urlencoded'
                },

                body: 'username=' + encodeURIComponent(c.user) +
                    '&password=' + encodeURIComponent(c.pass)

            }, function (result) {
                if (result === null) return callback(null);
                getData();
            });

        } else {
            getData();
        }
    }

    function extractHash(data) {
        data = data || {};

        var direct = data.hash ||
            data.Hash ||
            data.infohash ||
            data.InfoHash ||
            '';

        if (/^[a-f0-9]{40}$/i.test(String(direct))) {
            return String(direct).toLowerCase();
        }

        var magnet = data.MagnetUri ||
            data.magnetUri ||
            data.magnet ||
            data.Magnet ||
            '';

        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(
            String(magnet)
        );

        if (!match) return '';

        var hash = match[1];

        // Prefer a hexadecimal infohash from the torrent object.
        if (/^[a-f0-9]{40}$/i.test(hash)) {
            return hash.toLowerCase();
        }

        return '';
    }

    function buildSmbUrl(torrent, file) {
        var c = config();

        if (!c.smbRoot) {
            notify(
                'Укажи SMB-путь в настройках Lampa → qBittorrent → Папка SMB'
            );

            return '';
        }

        var savePath = String(torrent.save_path || '');
        var relativeSave = '';

        if (c.qbRoot) {
            relativeSave = relativeToRoot(
                savePath,
                c.qbRoot
            );

            if (relativeSave === null) {
                notify(
                    'Путь загрузки не находится внутри указанного корня qBittorrent'
                );

                return '';
            }
        }

        var fileName = String(file.name || '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '');

        if (!fileName || fileName.split('/').indexOf('..') !== -1) {
            notify('Не удалось определить безопасный путь к видеофайлу');
            return '';
        }

        var parts = [];

        if (relativeSave) {
            parts.push(
                relativeSave
                    .replace(/\\/g, '/')
                    .replace(/^\/+|\/+$/g, '')
            );
        }

        if (fileName) {
            parts.push(fileName);
        }

        return c.smbRoot + encodePath(
            parts.filter(Boolean).join('/')
        );
    }

    /*
     * Launch an Android implicit VIEW intent.
     * Compatible installed players can appear in Android's chooser.
     */
    function launchPlayer(url) {
        if (!url) {
            return notify('Не удалось сформировать SMB-ссылку на видео');
        }

        if (!/^smb:\/\//i.test(url)) {
            return notify('Неверная SMB-ссылка');
        }

        var intentUrl =
            'intent://' +
            url.replace(/^smb:\/\//i, '') +
            '#Intent;scheme=smb;' +
            'action=android.intent.action.VIEW;' +
            'type=video%2F%2A;end';

        try {
            window.location.href = intentUrl;

            notify(
                'Передаю видео в Android для выбора плеера…'
            );

        } catch (e) {
            notify(
                'Не удалось открыть плеер. Проверь поддержку SMB.'
            );
        }
    }

    function isConnected(element) {
        return !!(
            element &&
            (element.isConnected === undefined || element.isConnected)
        );
    }

    function checkTorrent(hash, button) {
        if (!hash || !isConnected(button)) return;

        api(
            '/api/v2/torrents/info?hashes=' +
                encodeURIComponent(hash),

            function (response) {
                if (!isConnected(button)) return;

                var torrents = parseJSON(response);

                if (!Array.isArray(torrents) || !torrents.length) {
                    return;
                }

                var torrent = torrents[0];
                var state = String(torrent.state || '').toLowerCase();

                var complete =
                    Number(torrent.progress) >= 0.999999 &&
                    Number(torrent.amount_left || 0) === 0 &&
                    !/(checking|moving|error|missingfiles|unknown)/i
                        .test(state);

                if (!complete) {
                    button.style.display = 'none';
                    button.dataset.ready = '0';
                    button.dataset.smbUrl = '';
                    return;
                }

                api(
                    '/api/v2/torrents/files?hash=' +
                        encodeURIComponent(hash),

                    function (fileResponse) {
                        if (!isConnected(button)) return;

                        var files = parseJSON(fileResponse);

                        if (!Array.isArray(files) || !files.length) {
                            button.style.display = 'none';
                            return;
                        }

                        var videos = files.filter(function (file) {
                            return VIDEO_EXT.test(
                                String(file.name || '')
                            ) &&
                            Number(file.progress) >= 0.999999;

                        }).sort(function (a, b) {
                            return Number(b.size || 0) -
                                Number(a.size || 0);
                        });

                        if (!videos.length) {
                            button.style.display = 'none';
                            button.dataset.ready = '0';
                            return;
                        }

                        // Select the largest fully downloaded video file.
                        var smbUrl = buildSmbUrl(
                            torrent,
                            videos[0]
                        );

                        button.dataset.smbUrl = smbUrl;
                        button.dataset.ready = smbUrl ? '1' : '0';

                        button.style.display = smbUrl
                            ? 'inline-flex'
                            : 'none';

                        button.textContent = videos.length > 1
                            ? '▶ Плеер · ' + videos.length
                            : '▶ Плеер';

                        button.title = videos.length > 1
                            ? 'Откроется самый большой полностью загруженный видеофайл'
                            : 'Открыть видео в медиаплеере';
                    }
                );
            }
        );
    }

    function startTracking(hash, button) {
        if (!hash || !button) return;

        var id = hash + ':' +
            Math.random().toString(36).slice(2);

        tracked[id] = true;

        function tick() {
            if (!tracked[id] || !isConnected(button)) {
                delete tracked[id];
                return;
            }

            checkTorrent(hash, button);

            setTimeout(tick, POLL_MS);
        }

        tick();
    }

    function resolveTorrentData(event) {
        var candidates = [
            event && event.element,
            event && event.data,
            event && event.object,
            event && event.item && event.item.data
        ];

        for (var i = 0; i < candidates.length; i++) {
            var value = candidates[i];

            if (value && typeof value === 'object') {
                if (value.jquery && value[0]) {
                    value = value[0];
                }

                if (
                    value.MagnetUri ||
                    value.magnetUri ||
                    value.magnet ||
                    value.hash ||
                    value.Hash ||
                    value.infohash
                ) {
                    return value;
                }
            }
        }

        return event &&
            event.element &&
            typeof event.element === 'object'
                ? event.element
                : {};
    }

    function addPlayerButton(item, data) {
        if (
            !item ||
            !item.querySelector ||
            item.querySelector('.qbit-player-btn')
        ) {
            return;
        }

        var hash = extractHash(data);

        if (!hash) {
            var magnet = item.getAttribute &&
                (
                    item.getAttribute('data-magnet') ||
                    item.getAttribute('data-hash')
                );

            hash = extractHash({
                magnet: magnet,
                hash: magnet
            });
        }

        if (!hash) return;

        var button = document.createElement('div');

        button.className = 'qbit-player-btn selector';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.textContent = '▶ Плеер';
        button.style.display = 'none';

        function activate(event) {
            if (event) {
                if (event.preventDefault) event.preventDefault();
                if (event.stopPropagation) event.stopPropagation();

                if (event.stopImmediatePropagation) {
                    event.stopImmediatePropagation();
                }
            }

            if (button.dataset.ready !== '1') {
                notify(
                    'Видео ещё загружается или не удалось проверить состояние торрента'
                );

                return false;
            }

            launchPlayer(button.dataset.smbUrl || '');

            return false;
        }

        button.addEventListener('click', activate);
        button.addEventListener('hover:enter', activate);

        button.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
                activate(event);
            }
        });

        item.appendChild(button);

        startTracking(hash, button);
    }

    function registerSettings() {
        if (
            !window.Lampa ||
            !Lampa.SettingsApi ||
            typeof Lampa.SettingsApi.addParam !== 'function'
        ) {
            return;
        }

        try {
            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',

                param: {
                    name: KEY_ENABLED,
                    type: 'trigger',
                    default: true
                },

                field: {
                    name: 'Кнопка «Плеер»',
                    description:
                        'Показывать кнопку после полной загрузки видео'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',

                param: {
                    name: KEY_SMB,
                    type: 'input',
                    values: '',
                    default: ''
                },

                field: {
                    name: 'Папка SMB',
                    description:
                        'Корень общей папки Windows, например smb://192.168.1.10/Torrents'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',

                param: {
                    name: KEY_QBROOT,
                    type: 'input',
                    values: '',
                    default: ''
                },

                field: {
                    name: 'Корневой путь qBittorrent',
                    description:
                        'Например D:\\Torrents. Должен соответствовать корню SMB; оставь пустым, если SMB-корень соответствует save_path.'
                }
            });

        } catch (e) {
            console.error(
                '[qB Player] Не удалось зарегистрировать настройки:',
                e
            );
        }
    }

    function initialize() {
        if (
            initialized ||
            !window.Lampa ||
            !Lampa.Listener ||
            typeof Lampa.Listener.follow !== 'function'
        ) {
            return;
        }

        initialized = true;

        registerSettings();

        Lampa.Listener.follow('torrent', function (event) {
            if (
                !event ||
                event.type !== 'render' ||
                !event.item ||
                !config().enabled
            ) {
                return;
            }

            var item = event.item.jquery
                ? event.item[0]
                : event.item;

            if (!item || !item.querySelector) return;

            addPlayerButton(
                item,
                resolveTorrentData(event)
            );
        });

        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');

            style.id = STYLE_ID;

            style.textContent =
                '.qbit-player-btn{' +
                    'display:inline-flex;' +
                    'align-items:center;' +
                    'justify-content:center;' +
                    'margin:8px;' +
                    'padding:10px 18px;' +
                    'background:#174b35;' +
                    'color:#fff;' +
                    'border:2px solid #4c9b75;' +
                    'border-radius:6px;' +
                    'font-size:18px;' +
                    'position:relative;' +
                    'z-index:999;' +
                    'cursor:pointer;' +
                    'outline:none' +
                '}' +
                '.qbit-player-btn.focus,' +
                '.qbit-player-btn:focus{' +
                    'border-color:#fff;' +
                    'background:#23734f' +
                '}';

            (document.head || document.documentElement)
                .appendChild(style);
        }

        console.log('[qB Player] Add-on initialized');
    }

    if (window.Lampa && Lampa.Listener) {
        initialize();
    } else {
        document.addEventListener(
            'appready',
            initialize,
            { once: true }
        );
    }
})();
