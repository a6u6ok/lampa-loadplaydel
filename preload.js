// ============================================================================
// qBittorrent для Lampa — Keenetic + Entware + SMB
// Управление отдельными файлами внутри торрента
// Исправленная версия (навигация пультом + только кнопка «Проиграть»)
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // НАСТРОЙКИ
    // ========================================================================

    var EXAMPLE_URL = 'http://192.168.1.1:9080';
    var EXAMPLE_SAVEPATH = '/mnt/storage/torrents';
    var EXAMPLE_SMB_FILE = 'smb://192.168.1.1/MEDIA/';

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;
    var VERIFY_INTERVAL = 1000;
    var VERIFY_ATTEMPTS = 8;

    var nativeRequestId = 0;
    var sid = '';
    var loggedIn = false;

    // Контроль текущего окна файлов, чтобы ответы старых запросов
    // не открывали лишние модальные окна.
    var activeFileModalHash = '';
    var fileModalRequestId = 0;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    var VIDEO_EXTENSIONS = [
        'mkv', 'mp4', 'avi', 'm4v', 'mov',
        'wmv', 'mpg', 'mpeg', 'ts', 'm2ts',
        'webm', 'flv', 'vob', 'ogv', '3gp'
    ];

    var SETTING_TEXT_FIELDS = [
        'qbit_url',
        'qbit_user',
        'qbit_pass',
        'qbit_savepath',
        'qbit_category',
        'qbit_smb_file',
        'qbit_player_package'
    ];

    // ========================================================================
    // ЛОГИ И УВЕДОМЛЕНИЯ
    // ========================================================================

    function log() {
        if (!DEBUG) return;

        console.log.apply(
            console,
            ['[qBittorrent]'].concat(
                Array.prototype.slice.call(arguments)
            )
        );
    }

    function notify(message) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(String(message));
                return;
            }
        } catch (error) {}

        console.log('[qBittorrent]', message);
    }

    function debugNotify(message) {
        if (DEBUG) notify(message);
    }

    window.addEventListener('error', function (event) {
        console.error(
            '[qBittorrent] SCRIPT ERROR:',
            event.message,
            'строка:',
            event.lineno,
            event.error
        );
    });

    window.addEventListener('unhandledrejection', function (event) {
        console.error(
            '[qBittorrent] PROMISE ERROR:',
            event.reason
        );
    });

    // ========================================================================
    // ХРАНИЛИЩЕ И НАСТРОЙКИ
    // ========================================================================

    function storeGet(key, defaultValue) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var value = Lampa.Storage.get(key, defaultValue);

                if (
                    value !== undefined &&
                    value !== null &&
                    value !== ''
                ) {
                    return value;
                }
            }
        } catch (error) {
            console.error('[qBittorrent] storeGet:', error);
        }

        return defaultValue;
    }

    function storeSet(key, value) {
        try {
            if (window.Lampa && Lampa.Storage) {
                Lampa.Storage.set(key, value);
            }
        } catch (error) {
            console.error('[qBittorrent] storeSet:', error);
        }
    }

    function isTrue(value, defaultValue) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;

        return defaultValue;
    }

    function cfg() {
        return {
            url: String(storeGet('qbit_url', '') || '').trim(),
            user: String(storeGet('qbit_user', '') || ''),
            pass: String(storeGet('qbit_pass', '') || ''),

            bypass: isTrue(storeGet('qbit_bypass', true), true),

            savepath: String(
                storeGet('qbit_savepath', '') || ''
            ).trim(),

            category: String(
                storeGet('qbit_category', '') || ''
            ).trim(),

            rename: isTrue(storeGet('qbit_rename', true), true),
            confirm: isTrue(storeGet('qbit_confirm', true), true),

            delete_files: isTrue(
                storeGet('qbit_delete_files', false), false
            ),

            external_player: isTrue(
                storeGet('qbit_external_player', true), true
            ),

            player_package: String(
                storeGet(
                    'qbit_player_package',
                    'top.rootu.dddplayer'
                ) || 'top.rootu.dddplayer'
            ).trim(),

            smb_file: String(
                storeGet('qbit_smb_file', '') || ''
            ).trim()
        };
    }

    function isConfigured() {
        var config = cfg();

        return !!(
            config.url &&
            config.savepath &&
            config.smb_file
        );
    }

    function base() {
        return cfg().url.replace(/\/+$/, '');
    }

    function requireSetup() {
        if (isConfigured()) return true;

        notify('Сначала настройте qBittorrent');
        openSetupWizard();

        return false;
    }

    // ========================================================================
    // ПУТИ И ФАЙЛЫ
    // ========================================================================

    function cleanFsPath(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/, '');
    }

    function encodeSmbPath(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(function (part) {
                return part !== '';
            })
            .map(function (part) {
                return encodeURIComponent(part);
            })
            .join('/');
    }

    function fileBasename(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .split('/')
            .pop();
    }

    function isVideoFile(filename) {
        var match = /\.([^.\/\\]+)$/.exec(
            String(filename || '').toLowerCase()
        );

        return !!(
            match &&
            VIDEO_EXTENSIONS.indexOf(match[1]) !== -1
        );
    }

    function formatSize(bytes) {
        bytes = Number(bytes) || 0;

        if (bytes >= 1073741824) {
            return (bytes / 1073741824).toFixed(2) + ' GB';
        }

        if (bytes >= 1048576) {
            return (bytes / 1048576).toFixed(1) + ' MB';
        }

        if (bytes >= 1024) {
            return (bytes / 1024).toFixed(1) + ' KB';
        }

        return bytes + ' B';
    }

    function escapeHtml(value) {
        return String(value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ========================================================================
    // MAGNET И HASH
    // ========================================================================

    function magnetHash(value) {
        value = String(value || '').trim();

        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(value);

        if (match) return match[1].toLowerCase();

        if (/^[a-f0-9]{40}$/i.test(value)) {
            return value.toLowerCase();
        }

        if (/^[a-f0-9]{64}$/i.test(value)) {
            return value.toLowerCase();
        }

        return '';
    }

    function extractMagnet(data) {
        if (!data) return '';

        if (typeof data === 'string') {
            return /^magnet:\?/i.test(data) ? data : '';
        }

        if (typeof data !== 'object') return '';

        var fields = [
            'MagnetUri', 'magnetUri', 'magnet_uri',
            'magnet', 'Magnet', 'url',
            'torrent_url', 'torrentUrl', 'link'
        ];

        for (var i = 0; i < fields.length; i++) {
            var value = data[fields[i]];

            if (
                typeof value === 'string' &&
                /^magnet:\?/i.test(value)
            ) {
                return value;
            }
        }

        return '';
    }

    function extractTorrentHash(data, depth) {
        depth = depth || 0;

        if (!data || depth > 5) return '';

        if (typeof data === 'string') {
            return magnetHash(data);
        }

        if (typeof data !== 'object') return '';

        var fields = [
            'hash', 'Hash', 'infohash', 'infoHash',
            'InfoHash', 'infohash_v1', 'infoHashV1', 'btih'
        ];

        for (var i = 0; i < fields.length; i++) {
            if (data[fields[i]]) {
                var hash = magnetHash(data[fields[i]]);
                if (hash) return hash;
            }
        }

        var magnet = extractMagnet(data);

        if (magnet) {
            var magnetValue = magnetHash(magnet);
            if (magnetValue) return magnetValue;
        }

        var nested = [
            'torrent', 'item', 'data', 'element',
            'source', 'model', 'card'
        ];

        for (var j = 0; j < nested.length; j++) {
            if (data[nested[j]]) {
                var result = extractTorrentHash(
                    data[nested[j]],
                    depth + 1
                );

                if (result) return result;
            }
        }

        return '';
    }

    // ========================================================================
    // МАСТЕР НАСТРОЙКИ
    // ========================================================================

    function openSetupWizard(onDone) {
        if (!window.Lampa || !Lampa.Modal) {
            notify('Настройки: Настройки → qBittorrent');
            return;
        }

        if (!window.jQuery) {
            notify('Не удалось открыть настройки: jQuery недоступен');
            return;
        }

        var config = cfg();

        function fieldHtml(id, label, value, example) {
            return (
                '<div class="qbit-wizard__field">' +
                    '<label>' + label + '</label>' +
                    '<input type="text" id="' + id + '"' +
                    ' value="' + escapeHtml(value) + '">' +
                    '<div class="qbit-wizard__hint">' +
                        'Пример: ' + escapeHtml(example) +
                    '</div>' +
                '</div>'
            );
        }

        var html = document.createElement('div');
        html.className = 'qbit-wizard';

        html.innerHTML =
            '<div class="qbit-wizard__desc">' +
                'Укажите параметры qBittorrent. ' +
                'Настройки сохраняются в Lampa.' +
            '</div>' +
            fieldHtml(
                'qbit-wz-url',
                'Адрес сервера',
                config.url,
                EXAMPLE_URL
            ) +
            fieldHtml(
                'qbit-wz-savepath',
                'Путь загрузок на роутере',
                config.savepath,
                EXAMPLE_SAVEPATH
            ) +
            fieldHtml(
                'qbit-wz-smb',
                'SMB-шара',
                config.smb_file,
                EXAMPLE_SMB_FILE
            ) +
            '<div class="qbit-wizard__actions">' +
                '<button class="qbit-wizard__btn qbit-wizard__save">' +
                    'Сохранить' +
                '</button>' +
                '<button class="qbit-wizard__btn qbit-wizard__cancel">' +
                    'Отмена' +
                '</button>' +
            '</div>';

        Lampa.Modal.open({
            title: 'qBittorrent — настройка',
            html: window.jQuery(html),
            size: 'medium',
            onBack: function () {
                Lampa.Modal.close();
                Lampa.Controller.toggle('content');
            }
        });

        function close() {
            try {
                Lampa.Modal.close();
            } catch (error) {}
        }

        window.jQuery(html).find('.qbit-wizard__cancel').on(
            'hover:enter click',
            close
        );

        window.jQuery(html).find('.qbit-wizard__save').on(
            'hover:enter click',
            function (event) {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }

                var url = html.querySelector(
                    '#qbit-wz-url'
                ).value.trim();

                var savepath = html.querySelector(
                    '#qbit-wz-savepath'
                ).value.trim();

                var smb = html.querySelector(
                    '#qbit-wz-smb'
                ).value.trim();

                if (!url || !savepath || !smb) {
                    notify('Заполните все три поля');
                    return;
                }

                storeSet('qbit_url', url);
                storeSet('qbit_savepath', savepath);
                storeSet('qbit_smb_file', smb);

                close();
                notify('Настройки сохранены');

                if (typeof onDone === 'function') {
                    onDone();
                }
            }
        );
    }

    // ========================================================================
    // HTTP
    // ========================================================================

    function normalizeResponse(response) {
        if (response === null || response === undefined) {
            return null;
        }

        if (typeof response === 'string') return response;

        if (typeof response === 'object') {
            if (typeof response.responseText === 'string') {
                return response.responseText;
            }

            if (typeof response.response === 'string') {
                return response.response;
            }

            if (typeof response.body === 'string') {
                return response.body;
            }

            if (typeof response.data === 'string') {
                return response.data;
            }

            try {
                return JSON.stringify(response);
            } catch (error) {
                return null;
            }
        }

        return String(response);
    }

    function fetchRequest(request, callback) {
        if (typeof fetch !== 'function') {
            callback(null);
            return;
        }

        var options = {
            method: request.method || 'GET',
            headers: request.headers || CT_FORM,
            credentials: 'include'
        };

        if (request.body !== undefined && request.body !== null) {
            options.body = request.body;
        }

        fetch(request.url, options)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                return response.text();
            })
            .then(callback)
            .catch(function (error) {
                console.error('[qBittorrent] fetch:', error);
                callback(null);
            });
    }

    function nativeRequest(request, callback) {
        var finished = false;
        var requestId = ++nativeRequestId;

        var payload = {
            url: request.url,
            timeout: 20000,
            headers: request.headers || {}
        };

        if (request.body !== undefined && request.body !== null) {
            payload.post_data = String(request.body);
        }

        function finish(response) {
            if (finished) return;

            finished = true;
            callback(normalizeResponse(response));
        }

        function fallback() {
            if (finished) return;

            finished = true;
            log('Переключение на fetch');
            fetchRequest(request, callback);
        }

        if (
            !window.AndroidJS ||
            typeof window.AndroidJS.httpReq !== 'function' ||
            typeof window.AndroidJS.getResp !== 'function'
        ) {
            fetchRequest(request, callback);
            return;
        }

        try {
            window.AndroidJS.httpReq(
                JSON.stringify(payload),
                requestId
            );
        } catch (error) {
            console.error('[qBittorrent] httpReq:', error);
            fetchRequest(request, callback);
            return;
        }

        var tries = 0;

        (function poll() {
            if (finished) return;

            tries++;

            var response = null;

            try {
                response = window.AndroidJS.getResp(
                    String(requestId)
                );
            } catch (error) {}

            if (response !== null && response !== undefined) {
                var normalized = normalizeResponse(response);

                if (normalized !== null && normalized.length > 0) {
                    finish(normalized);
                    return;
                }
            }

            if (tries >= 150) {
                fallback();
                return;
            }

            setTimeout(poll, 150);
        })();
    }

    // ========================================================================
    // АВТОРИЗАЦИЯ
    // ========================================================================

    function authHeaders() {
        var headers = {
            'Content-Type':
                'application/x-www-form-urlencoded'
        };

        if (sid) headers.Cookie = 'SID=' + sid;

        return headers;
    }

    function doLogin(done) {
        var config = cfg();

        if (config.bypass || !config.user) {
            loggedIn = true;
            done(true);
            return;
        }

        nativeRequest({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body:
                'username=' + encodeURIComponent(config.user) +
                '&password=' + encodeURIComponent(config.pass),
            headers: CT_FORM
        }, function (response) {
            if (
                !response ||
                /Forbidden|403|Fails/i.test(response) ||
                !/^Ok\./i.test(String(response).trim())
            ) {
                loggedIn = false;
                notify('Ошибка авторизации qBittorrent');
                done(false);
                return;
            }

            var cookieMatch = /SID=([^;\s]+)/i.exec(
                String(response)
            );

            if (cookieMatch) sid = cookieMatch[1];

            loggedIn = true;
            done(true);
        });
    }

    function qbRequest(request, callback) {
        var config = cfg();

        if (config.bypass || !config.user) {
            nativeRequest(request, callback);
            return;
        }

        if (!loggedIn) {
            doLogin(function (success) {
                if (!success) {
                    callback(null);
                    return;
                }

                request.headers = authHeaders();
                nativeRequest(request, callback);
            });

            return;
        }

        request.headers = authHeaders();
        nativeRequest(request, callback);
    }

    function qbGet(path, callback) {
        qbRequest({
            url: base() + path,
            method: 'GET',
            headers: authHeaders()
        }, callback);
    }

    function qbPost(path, body, callback) {
        qbRequest({
            url: base() + path,
            method: 'POST',
            body: body,
            headers: authHeaders()
        }, callback);
    }
      // ========================================================================
    // ДОБАВЛЕНИЕ ТОРРЕНТА
    // ========================================================================

    function buildAddBody(magnet, title) {
        var config = cfg();
        var params = [];

        params.push('urls=' + encodeURIComponent(magnet));

        params.push(
            'savepath=' +
            encodeURIComponent(cleanFsPath(config.savepath))
        );

        if (config.category) {
            params.push(
                'category=' + encodeURIComponent(config.category)
            );
        }

        params.push('autoTMM=false');
        params.push('contentLayout=NoSubfolder');
        params.push('paused=false');
        params.push('sequentialDownload=false');

        if (config.rename && title) {
            params.push('rename=' + encodeURIComponent(title));
        }

        return params.join('&');
    }

    function checkTorrentProgress(hash, onProgress) {
        if (!hash) {
            onProgress(null);
            return;
        }

        qbGet(
            '/api/v2/torrents/info?hashes=' +
            encodeURIComponent(hash),
            function (response) {
                if (typeof response !== 'string' || !response.length) {
                    onProgress(null);
                    return;
                }

                try {
                    var data = JSON.parse(response);
                    var torrents = Array.isArray(data) ?
                        data : (data.torrents || []);

                    onProgress(
                        torrents.length ?
                            Number(torrents[0].progress) || 0 :
                            null
                    );
                } catch (error) {
                    onProgress(null);
                }
            }
        );
    }

    function verifyTorrentAdded(hash, attempt, callback) {
        attempt = attempt || 0;

        if (!hash) {
            callback(false);
            return;
        }

        checkTorrentProgress(hash, function (progress) {
            if (progress !== null) {
                callback(true);
                return;
            }

            if (attempt + 1 >= VERIFY_ATTEMPTS) {
                callback(false);
                return;
            }

            setTimeout(function () {
                verifyTorrentAdded(hash, attempt + 1, callback);
            }, VERIFY_INTERVAL);
        });
    }

    function qbAdd(magnet, title, onComplete) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Не удалось получить magnet-ссылку');
            if (onComplete) onComplete(false);
            return;
        }

        debugNotify('Отправляю в qBittorrent...');

        qbPost(
            '/api/v2/torrents/add',
            buildAddBody(magnet, title),
            function (response) {
                if (response === null || response === undefined) {
                    notify('Нет связи с qBittorrent');
                    if (onComplete) onComplete(false);
                    return;
                }

                if (/Forbidden|403|Errored/i.test(response)) {
                    notify('Ошибка добавления: ' + response);
                    if (onComplete) onComplete(false);
                    return;
                }

                var hash = magnetHash(magnet);

                if (!cfg().confirm) {
                    notify('Отправлено в qBittorrent');
                    if (onComplete) onComplete(true);
                    return;
                }

                verifyTorrentAdded(hash, 0, function (found) {
                    notify(
                        found ?
                            'Торрент успешно добавлен' :
                            'Запрос отправлен. Проверьте список торрентов.'
                    );

                    if (onComplete) onComplete(true, found);
                });
            }
        );
    }

    // ========================================================================
    // УДАЛЕНИЕ ВСЕГО ТОРРЕНТА
    // ========================================================================

    function qbDelete(hashOrMagnet, onComplete) {
        var hash = magnetHash(hashOrMagnet);

        if (!hash) {
            notify('Не удалось определить хеш торрента');
            if (onComplete) onComplete(false);
            return;
        }

        var body =
            'hashes=' + encodeURIComponent(hash) +
            '&deleteFiles=' +
            (cfg().delete_files ? 'true' : 'false');

        qbPost(
            '/api/v2/torrents/delete',
            body,
            function (response) {
                if (response === null || response === undefined) {
                    notify('Нет связи с qBittorrent');
                    if (onComplete) onComplete(false);
                    return;
                }

                if (/Forbidden|403|Fails/i.test(response)) {
                    notify('Ошибка удаления торрента');
                    if (onComplete) onComplete(false);
                    return;
                }

                notify(
                    cfg().delete_files ?
                        'Торрент и его файлы удалены' :
                        'Торрент удалён из списка'
                );

                if (onComplete) onComplete(true);
            }
        );
    }

    // ========================================================================
    // SMB И ЗАПУСК ПЛЕЕРА
    // ========================================================================

function makeSmbUri(fileName) {
    var smbRoot = String(cfg().smb_file || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');

    // Берем только имя файла, игнорируя пути подпапок
    var file = fileBasename(fileName);

    var result = smbRoot +
        (file ? '/' + encodeSmbPath(file) : '');

    log('SMB URI (NoSubfolder mode):', result);

    return result;
}


    function openFileInPlayer(fileUri, title) {
        var uri = String(fileUri || '').trim();

        if (!uri) {
            notify('Не указан путь к видеофайлу');
            return;
        }

        var config = cfg();
        var extension = '';
        var match = /\.([^.\/?#]+)(?:[?#]|$)/i.exec(uri);

        if (match) extension = '.' + match[1].toLowerCase();

        var playerData = {
            url: uri,
            title: title || 'qBittorrent',
            source: 'qBittorrent',
            quality: 'auto',
            exe: extension
        };

        if (config.external_player) {
            if (
                window.AndroidJS &&
                typeof window.AndroidJS.openPlayer === 'function'
            ) {
                try {
                    window.AndroidJS.openPlayer(
                        uri,
                        JSON.stringify(playerData)
                    );
                    return;
                } catch (error) {
                    console.error('[qBittorrent] openPlayer:', error);
                    notify('Ошибка запуска видео');
                    return;
                }
            }

            notify('AndroidJS.openPlayer недоступен');
            return;
        }

        try {
            if (
                window.Lampa &&
                Lampa.Player &&
                typeof Lampa.Player.play === 'function'
            ) {
                Lampa.Player.play(playerData);
                return;
            }
        } catch (error) {
            console.error('[qBittorrent] Lampa.Player:', error);
            notify('Ошибка встроенного плеера');
            return;
        }

        notify('Не удалось запустить плеер Lampa');
    }

    // ========================================================================
    // ИНФОРМАЦИЯ О СЕРИЯХ
    // ========================================================================

    function getEpisodeInfo(filename) {
        var name = fileBasename(filename);

        var patterns = [
            /S(\d{1,2})E(\d{1,3})/i,
            /(\d{1,2})x(\d{1,3})/i,
            /Season[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})/i,
            /Сезон[\s._-]*(\d{1,2})[\s._-]*Серия[\s._-]*(\d{1,3})/i,
            /(\d{1,2})\s*сезон[\s._-]*(\d{1,3})\s*серия/i
        ];

        for (var i = 0; i < patterns.length; i++) {
            var match = patterns[i].exec(name);

            if (match) {
                return {
                    season: Number(match[1]),
                    episode: Number(match[2]),
                    found: true
                };
            }
        }

        return {
            season: 0,
            episode: 0,
            found: false
        };
    }

    function compareVideoFiles(a, b) {
        var infoA = getEpisodeInfo(a.name);
        var infoB = getEpisodeInfo(b.name);

        if (infoA.found && !infoB.found) return -1;
        if (!infoA.found && infoB.found) return 1;

        if (infoA.found && infoB.found) {
            if (infoA.season !== infoB.season) {
                return infoA.season - infoB.season;
            }

            if (infoA.episode !== infoB.episode) {
                return infoA.episode - infoB.episode;
            }
        }

        return String(a.name).localeCompare(
            String(b.name),
            undefined,
            {
                numeric: true,
                sensitivity: 'base'
            }
        );
    }

    // ========================================================================
    // ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ТОРРЕНТЕ
    // ========================================================================

    function getTorrentInfo(hash, callback) {
        qbGet(
            '/api/v2/torrents/info?hashes=' +
            encodeURIComponent(hash),
            function (response) {
                if (!response) {
                    callback(null);
                    return;
                }

                try {
                    var data = JSON.parse(response);
                    var torrents = Array.isArray(data) ?
                        data : (data.torrents || []);

                    callback(torrents.length ? torrents[0] : null);
                } catch (error) {
                    console.error(
                        '[qBittorrent] torrent info:',
                        error
                    );

                    callback(null);
                }
            }
        );
    }

    function getTorrentFiles(hash, callback) {
        qbGet(
            '/api/v2/torrents/files?hash=' +
            encodeURIComponent(hash),
            function (response) {
                if (!response) {
                    callback(null);
                    return;
                }

                try {
                    var files = JSON.parse(response);

                    callback(
                        Array.isArray(files) ? files : null
                    );
                } catch (error) {
                    console.error(
                        '[qBittorrent] files parse:',
                        error
                    );

                    callback(null);
                }
            }
        );
    }

    // ========================================================================
    // ПРИОРИТЕТ ОТДЕЛЬНОГО ФАЙЛА
    // (API оставлен, но в UI больше не используется)
    // ========================================================================

    function setFilePriority(hash, fileId, priority, callback) {
        var body =
            'hash=' + encodeURIComponent(hash) +
            '&id=' + encodeURIComponent(fileId) +
            '&priority=' + encodeURIComponent(priority);

        qbPost(
            '/api/v2/torrents/filePrio',
            body,
            function (response) {
                // qBittorrent обычно возвращает пустое тело при успехе.
                // Поэтому пустая строка считается успешным ответом,
                // а null означает отсутствие ответа.
                var success = (
                    response !== null &&
                    response !== undefined &&
                    !/Forbidden|403|Fails|Errored/i.test(response)
                );

                if (callback) callback(success, response);
            }
        );
    }

    // ========================================================================
    // ОТКРЫТИЕ ВИДЕОФАЙЛА
    // ========================================================================

    function playTorrentFile(file, torrent) {
        if (!file) {
            notify('Файл не выбран');
            return;
        }

        if (Number(file.progress) < 0.999999) {
            notify('Этот файл ещё не загружен полностью');
            return;
        }

        if (!isVideoFile(file.name)) {
            notify('Выбранный файл не является видео');
            return;
        }

        var fileName = fileBasename(file.name);
        var smbUri = makeSmbUri(file.name);

        log('Запуск отдельного файла:', file.name);
        log('Размер:', formatSize(file.size));
        log('SMB:', smbUri);

        openFileInPlayer(smbUri, fileName);
    }

    // ========================================================================
    // ОБНОВЛЕНИЕ СПИСКА ФАЙЛОВ
    // ========================================================================

    function refreshFileModal(hash) {
        var requestId = ++fileModalRequestId;

        getTorrentInfo(hash, function (torrent) {
            if (requestId !== fileModalRequestId) return;

            if (!torrent) {
                notify('Торрент не найден');
                return;
            }

            getTorrentFiles(hash, function (files) {
                if (requestId !== fileModalRequestId) return;

                if (!files) {
                    notify('Не удалось обновить список файлов');
                    return;
                }

                // Повторно используем уже открытое окно,
                // а не накладываем новую модалку поверх старой.
                renderTorrentFiles(hash, torrent, files, true);
            });
        });
    }

    // ========================================================================
    // НАВИГАЦИЯ ПУЛЬТОМ В ОКНЕ ФАЙЛОВ
    // ========================================================================

    // Храним активное состояние окна файлов:
    // элементы кнопок, индексы и ссылку на контейнер со списком.
    var fileModalNav = {
        buttons: [],
        index: 0,
        listEl: null,
        onKeyDown: null,
        onKeyUp: null
    };

    function cleanupFileModalNav() {
        if (fileModalNav.onKeyDown) {
            document.removeEventListener(
                'keydown',
                fileModalNav.onKeyDown,
                true
            );
            fileModalNav.onKeyDown = null;
        }

        if (fileModalNav.onKeyUp) {
            document.removeEventListener(
                'keyup',
                fileModalNav.onKeyUp,
                true
            );
            fileModalNav.onKeyUp = null;
        }

        fileModalNav.buttons = [];
        fileModalNav.index = 0;
        fileModalNav.listEl = null;
    }

    function focusFileButton(index) {
        var buttons = fileModalNav.buttons;

        if (!buttons.length) return;

        // Заворачивание по кругу
        if (index < 0) index = buttons.length - 1;
        if (index >= buttons.length) index = 0;

        fileModalNav.index = index;

        buttons.forEach(function (button, i) {
            if (!button) return;

            if (i === index) {
                button.classList.add('focus');
            } else {
                button.classList.remove('focus');
            }
        });

        // Прокрутка списка к активной кнопке
        var active = buttons[index];

        if (active && fileModalNav.listEl) {
            try {
                var listRect =
                    fileModalNav.listEl.getBoundingClientRect();
                var btnRect = active.getBoundingClientRect();

                // Верхняя граница списка + отступ
                var topMargin = 40;

                if (btnRect.top < listRect.top + topMargin) {
                    fileModalNav.listEl.scrollTop -=
                        (listRect.top + topMargin) - btnRect.top;
                } else if (btnRect.bottom > listRect.bottom - 10) {
                    fileModalNav.listEl.scrollTop +=
                        btnRect.bottom -
                        (listRect.bottom - 10);
                }
            } catch (error) {}
        }
    }

    function installFileModalNav(buttons, listEl) {
        cleanupFileModalNav();

        fileModalNav.buttons = buttons;
        fileModalNav.index = 0;
        fileModalNav.listEl = listEl;

        if (!buttons.length) return;

        focusFileButton(0);

        function isModalOpen() {
            try {
                return !!document.querySelector('.qbit-files');
            } catch (error) {
                return false;
            }
        }

        function activateCurrent() {
            var active = fileModalNav.buttons[fileModalNav.index];

            if (!active) return;

            try {
                active.click();
            } catch (error) {}
        }

        fileModalNav.onKeyDown = function (event) {
            if (!isModalOpen()) return;

            var key = event.keyCode || event.which;

            // 38 — вверх, 40 — вниз
            // 13 — Enter, 37/39 — влево/вправо (игнор)
            if (key === 38) {
                event.preventDefault();
                event.stopPropagation();
                focusFileButton(fileModalNav.index - 1);
                return;
            }

            if (key === 40) {
                event.preventDefault();
                event.stopPropagation();
                focusFileButton(fileModalNav.index + 1);
                return;
            }

            if (key === 13) {
                event.preventDefault();
                event.stopPropagation();
                activateCurrent();
                return;
            }
        };

        fileModalNav.onKeyUp = null;

        document.addEventListener(
            'keydown',
            fileModalNav.onKeyDown,
            true
        );
    }

    // ========================================================================
    // ОКНО УПРАВЛЕНИЯ ФАЙЛАМИ
    // (только кнопка «Проиграть» + навигация пультом)
    // ========================================================================

    function renderTorrentFiles(hash, torrent, files, isRefresh) {
        if (!window.Lampa || !Lampa.Modal) {
            notify('Окно файлов недоступно');
            return;
        }

        if (!window.jQuery) {
            notify('Не удалось открыть список файлов: jQuery недоступен');
            return;
        }

        var videoFiles = files.filter(function (file) {
            return isVideoFile(file.name);
        });

        videoFiles.sort(compareVideoFiles);

        if (!videoFiles.length) {
            notify('В торренте нет видеофайлов');
            return;
        }

        var completed = videoFiles.filter(function (file) {
            return Number(file.progress) >= 0.999999;
        }).length;

        var html = document.createElement('div');
        html.className = 'qbit-files';

        var torrentName = torrent.name || 'Торрент';

        var header =
            '<div class="qbit-files__header">' +
                '<div class="qbit-files__torrent">' +
                    escapeHtml(torrentName) +
                '</div>' +
                '<div class="qbit-files__summary">' +
                    'Видео: ' + videoFiles.length +
                    ' · Загружено: ' + completed +
                '</div>' +
                '<div class="qbit-files__hint">' +
                    'Стрелки вверх/вниз — выбор серии, OK — воспроизвести' +
                '</div>' +
            '</div>';

        var list = '<div class="qbit-files__list">';

        videoFiles.forEach(function (file) {
            var progress = Math.max(
                0,
                Math.min(100, Math.floor(
                    (Number(file.progress) || 0) * 100
                ))
            );

            var ready = progress >= 100;
            var name = fileBasename(file.name);
            var episode = getEpisodeInfo(file.name);

            var episodeLabel = episode.found ?
                'Сезон ' + episode.season +
                ' · Серия ' + episode.episode :
                '';

            var status = ready ?
                'Загружено' :
                'Загрузка: ' + progress + '%';

            var priority = Number(file.priority);
            var excluded = priority === 0;

            if (excluded && !ready) {
                status = 'Не загружается';
            }

            list +=
                '<div class="qbit-file" data-file-id="' +
                    escapeHtml(file.id) + '">' +

                    '<div class="qbit-file__info">' +
                        '<div class="qbit-file__name">' +
                            escapeHtml(name) +
                        '</div>' +

                        (episodeLabel ?
                            '<div class="qbit-file__episode">' +
                                escapeHtml(episodeLabel) +
                            '</div>' : '') +

                        '<div class="qbit-file__meta">' +
                            escapeHtml(status) +
                            ' · ' + formatSize(file.size) +
                        '</div>' +

                        '<div class="qbit-file__progress">' +
                            '<div style="width:' + progress + '%"></div>' +
                        '</div>' +
                    '</div>' +

                    '<div class="qbit-file__actions">' +
                        '<button class="qbit-file__button qbit-file__play"' +
                            ' data-action="play"' +
                            ' data-id="' + escapeHtml(file.id) + '"' +
                            (ready ? '' : ' disabled') + '>' +
                            'Проиграть' +
                        '</button>' +
                    '</div>' +
                '</div>';
        });

        list += '</div>';

        var footer =
            '<div class="qbit-files__footer">' +
                '<button class="qbit-files__refresh">' +
                    'Обновить список' +
                '</button>' +
            '</div>';

        html.innerHTML = header + list + footer;

        if (isRefresh && activeFileModalHash === hash) {
            try {
                Lampa.Modal.close();
            } catch (error) {}
        }

        activeFileModalHash = hash;

        Lampa.Modal.open({
            title: 'Файлы торрента',
            html: window.jQuery(html),
            size: 'large',
            align: 'top',
            mask: true,
            onBack: function () {
                activeFileModalHash = '';
                fileModalRequestId++;

                cleanupFileModalNav();

                Lampa.Modal.close();
                Lampa.Controller.toggle('content');
            }
        });

        var $html = window.jQuery(html);

        // ------------------------------------------------
        // Воспроизвести серию
        // ------------------------------------------------

        $html.find('[data-action="play"]').on(
            'hover:enter click',
            function (event) {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }

                var id = this.getAttribute('data-id');
                var selected = null;

                for (var i = 0; i < files.length; i++) {
                    if (String(files[i].id) === String(id)) {
                        selected = files[i];
                        break;
                    }
                }

                if (!selected) {
                    notify('Файл не найден');
                    return;
                }

                playTorrentFile(selected, torrent);
            }
        );

        // ------------------------------------------------
        // Обновить список серий
        // ------------------------------------------------

        $html.find('.qbit-files__refresh').on(
            'hover:enter click',
            function (event) {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }

                refreshFileModal(hash);
            }
        );

        // ------------------------------------------------
        // Навигация пультом
        // ------------------------------------------------

        var navButtons = [];

        // Кнопки «Проиграть» в порядке следования серий
        $html.find('[data-action="play"]').each(function () {
            navButtons.push(this);
        });

        // Кнопка «Обновить список» в конце
        $html.find('.qbit-files__refresh').each(function () {
            navButtons.push(this);
        });

        var listEl = html.querySelector('.qbit-files__list');

        installFileModalNav(navButtons, listEl);
    }

    // ========================================================================
    // ПОВТОРНОЕ ПОЛУЧЕНИЕ СПИСКА ФАЙЛОВ
    // ========================================================================

    function requestTorrentFiles(hash, attempt, callback) {
        attempt = attempt || 0;

        qbRequest({
            url: base() +
                '/api/v2/torrents/files?hash=' +
                encodeURIComponent(hash),
            method: 'GET',
            headers: authHeaders()
        }, function (response) {
            var files = [];

            try {
                if (typeof response === 'string' && response.length) {
                    files = JSON.parse(response);
                }
            } catch (error) {
                console.error(
                    '[qBittorrent] Ошибка разбора списка файлов:',
                    response,
                    error
                );
            }

            if (Array.isArray(files) && files.length) {
                log('Получено файлов:', files.length);
                callback(files);
                return;
            }

            log(
                'Список файлов пуст. Попытка:',
                attempt + 1,
                'Хеш:',
                hash,
                'Ответ:',
                response
            );

            if (attempt >= 7) {
                callback([]);
                return;
            }

            setTimeout(function () {
                requestTorrentFiles(
                    hash,
                    attempt + 1,
                    callback
                );
            }, 1500);
        });
    }

    // ========================================================================
    // ОТКРЫТИЕ СПИСКА СЕРИЙ ПО КНОПКЕ-ПАПКЕ
    // ========================================================================

    function handleFolderButton(hash) {
        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        if (!requireSetup()) return;

        log('Открытие списка серий. Хеш:', hash);
        debugNotify('Получаю список серий...');

        getTorrentInfo(hash, function (torrent) {
            if (!torrent) {
                notify('Торрент не найден в qBittorrent');
                return;
            }

            requestTorrentFiles(
                hash,
                0,
                function (files) {
                    if (!files || !files.length) {
                        notify(
                            'Не удалось получить список файлов торрента'
                        );
                        return;
                    }

                    var videoFiles = files.filter(function (file) {
                        return isVideoFile(file.name);
                    });

                    if (!videoFiles.length) {
                        notify('В торренте нет видеофайлов');
                        return;
                    }

                    log(
                        'Открываю список серий:',
                        videoFiles.length
                    );

                    // Общий прогресс торрента здесь не проверяется:
                    // список доступен ещё до завершения загрузки.
                    renderTorrentFiles(hash, torrent, files, false);
                }
            );
        });
    }

    // ========================================================================
    // ПОЛУЧЕНИЕ ФАЙЛОВ И ЗАПУСК ПЕРВОГО ГОТОВОГО ВИДЕО
    // ========================================================================

    function handlePlayerButton(hash) {
        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        if (!requireSetup()) return;

        log('Хеш из карточки:', hash);
        debugNotify('Получаю информацию о торренте...');

        qbRequest({
            url: base() +
                '/api/v2/torrents/info?hashes=' +
                encodeURIComponent(hash),
            method: 'GET',
            headers: authHeaders()
        }, function (infoResponse) {
            if (!infoResponse) {
                notify('Не удалось получить информацию о торренте');
                return;
            }

            var torrent;

            try {
                var info = JSON.parse(infoResponse);

                var torrents = Array.isArray(info) ?
                    info :
                    (info.torrents || []);

                if (!torrents.length) {
                    notify('Торрент не найден в qBittorrent');
                    log('Ответ torrents/info:', infoResponse);
                    return;
                }

                torrent = torrents[0];

            } catch (error) {
                console.error(
                    '[qBittorrent] Ошибка разбора информации:',
                    error
                );

                notify('Ошибка чтения информации о торренте');
                return;
            }

            var actualHash = String(
                torrent.hash || hash
            ).trim().toLowerCase();

            log('Хеш qBittorrent:', actualHash);
            log('Название:', torrent.name);
            log('Прогресс:', torrent.progress);
            log('Метаданные:', torrent.hasMetadata);

            if (!actualHash) {
                notify('qBittorrent не вернул хеш торрента');
                return;
            }

            if (Number(torrent.progress) < 0.999999) {
                notify('Торрент ещё не загружен полностью');
                return;
            }

            debugNotify('Получаю список файлов...');

            requestTorrentFiles(
                actualHash,
                0,
                function (files) {
                    if (!files || !files.length) {
                        notify(
                            'qBittorrent не вернул список файлов. ' +
                            'Проверьте метаданные и хеш торрента.'
                        );

                        log('Пустой список файлов. Хеш:', actualHash);
                        return;
                    }

                    log('Всего файлов:', files.length);

                    var videoFiles = files.filter(function (file) {
                        var name = String(file.name || '');

                        if (!isVideoFile(name)) return false;

                        if (Number(file.progress) < 0.999999) {
                            return false;
                        }

                        if (
                            /sample|trailer|preview|прочее/i.test(name)
                        ) {
                            return false;
                        }

                        return true;
                    });

                    if (!videoFiles.length) {
                        notify(
                            'Нет полностью загруженных видеофайлов'
                        );
                        return;
                    }

                    videoFiles.sort(compareVideoFiles);

                    var selectedFile = videoFiles[0];

                    var fileTitle = fileBasename(selectedFile.name);
                    var smbUri = makeSmbUri(selectedFile.name);

                    log('Выбрана серия:', selectedFile.name);
                    log('Размер:', formatSize(selectedFile.size));
                    log('SMB URI:', smbUri);

                    notify('Запускаю: ' + fileTitle);

                    openFileInPlayer(smbUri, fileTitle);
                }
            );
        });
    }
    // ========================================================================
    // ОБРАБОТКА НАЖАТИЙ
    // ========================================================================

    function bindPress(element, handler) {
        var last = 0;

        function wrapped(event) {
            var now = Date.now();

            if (now - last < ACTION_LOCK_MS) return;

            last = now;

            if (event) {
                if (event.preventDefault) {
                    event.preventDefault();
                }

                if (event.stopPropagation) {
                    event.stopPropagation();
                }

                if (event.stopImmediatePropagation) {
                    event.stopImmediatePropagation();
                }
            }

            handler(event);
        }

        if (window.jQuery) {
            window.jQuery(element).on('hover:enter', wrapped);
            window.jQuery(element).on('click', wrapped);
        } else {
            element.addEventListener('click', wrapped);
        }
    }

    // ========================================================================
    // КНОПКА ПРОГРЕССА
    // ========================================================================

    function applyProgressToButton(button, progress, iconSvg) {
        if (!button) return;

        if (progress === null || progress === undefined) {
            button.classList.remove('qbit-loading', 'qbit-done');

            button.innerHTML = iconSvg +
                '<span class="qbit-btn-text">qB</span>';

            return;
        }

        if (progress >= 1) {
            button.classList.remove('qbit-loading');
            button.classList.add('qbit-done');

            button.innerHTML = iconSvg +
                '<span class="qbit-btn-text">Готов</span>';

            return;
        }

        button.classList.add('qbit-loading');
        button.classList.remove('qbit-done');

        var percent = Math.floor(progress * 100);
        percent = Math.max(0, Math.min(99, percent));

        button.innerHTML = iconSvg +
            '<span class="qbit-btn-text">' +
            percent + '%' +
            '</span>';
    }

    function resetButtonToQb(button, iconSvg) {
        if (!button) return;

        stopProgressPolling(button);

        button.dataset.qbitAdding = '0';

        applyProgressToButton(button, null, iconSvg);
    }

    // ========================================================================
    // POLLING ПРОГРЕССА
    // ========================================================================

    function stopProgressPolling(button) {
        if (!button) return;

        if (button._qbitTimer) {
            clearInterval(button._qbitTimer);
            button._qbitTimer = null;
        }

        button.dataset.qbitPolling = '0';
    }

    function startProgressPolling(button, hash, item, iconSvg) {
        if (!button || !hash) return;
        if (button._qbitTimer) return;

        button.dataset.qbitPolling = '1';

        button._qbitTimer = setInterval(function () {
            try {
                if (
                    !document.body.contains(item) ||
                    !document.body.contains(button)
                ) {
                    stopProgressPolling(button);
                    return;
                }

                checkTorrentProgress(hash, function (progress) {
                    if (button.dataset.qbitPolling !== '1') return;

                    if (!document.body.contains(button)) {
                        stopProgressPolling(button);
                        return;
                    }

                    if (progress === null) {
                        stopProgressPolling(button);
                        applyProgressToButton(button, null, iconSvg);
                        return;
                    }

                    if (progress >= 1) {
                        stopProgressPolling(button);
                        applyProgressToButton(button, 1, iconSvg);
                        notify('Загрузка завершена!');
                        return;
                    }

                    applyProgressToButton(
                        button,
                        progress,
                        iconSvg
                    );
                });
            } catch (error) {
                stopProgressPolling(button);
                console.error('[qBittorrent] polling:', error);
            }
        }, POLL_INTERVAL);
    }

    function restoreTorrentState(button, hash, item, iconSvg) {
        if (!button || !hash) return;

        stopProgressPolling(button);

        checkTorrentProgress(hash, function (progress) {
            if (
                !document.body.contains(button) ||
                !document.body.contains(item)
            ) {
                return;
            }

            if (progress === null) {
                applyProgressToButton(button, null, iconSvg);
                return;
            }

            if (progress >= 1) {
                applyProgressToButton(button, 1, iconSvg);
                return;
            }

            applyProgressToButton(button, progress, iconSvg);

            startProgressPolling(
                button,
                hash,
                item,
                iconSvg
            );
        });
    }

    // ========================================================================
    // РЕГИСТРАЦИЯ НАСТРОЕК
    // ========================================================================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) {
                console.error('[qBittorrent] SettingsApi unavailable');
                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',

                icon:
                    '<svg viewBox="0 0 24 24" width="24" height="24">' +
                    '<path fill="currentColor" d="' +
                    'M12 2l3.09 6.26L22 9.27l-5 4.87' +
                    ' 1.18 6.88L12 17.77l-6.18 3.25' +
                    'L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
                    '</svg>',

                name: 'qBittorrent'
            });

            var params = [
                ['qbit_url', 'input', '', 'Адрес сервера',
                    'Пример: ' + EXAMPLE_URL],

                ['qbit_user', 'input', '', 'Логин',
                    'Логин Web UI'],

                ['qbit_pass', 'input', '', 'Пароль',
                    'Пароль Web UI'],

                ['qbit_bypass', 'trigger', true,
                    'Обход аутентификации',
                    'Для локальной сети'],

                ['qbit_savepath', 'input', '',
                    'Путь загрузки qBittorrent',
                    'Пример: ' + EXAMPLE_SAVEPATH],

                ['qbit_category', 'input', '',
                    'Категория',
                    'Например: video'],

                ['qbit_rename', 'trigger', true,
                    'Переименовывать торрент', ''],

                ['qbit_confirm', 'trigger', true,
                    'Проверять добавление',
                    'Проверять появление торрента после отправки'],

                ['qbit_delete_files', 'trigger', false,
                    'Удалять файлы при удалении торрента',
                    'Применяется только при удалении всего торрента'],

                ['qbit_external_player', 'trigger', true,
                    'Запускать через внешний плеер AndroidJS',
                    'Используется AndroidJS.openPlayer. ' +
                    'При выключении используется плеер Lampa'],

                ['qbit_player_package', 'input',
                    'top.rootu.dddplayer',
                    'Пакет внешнего плеера (справочно)',
                    'Параметр хранится в настройках. ' +
                    'AndroidJS.openPlayer самостоятельно выбирает плеер'],

                ['qbit_smb_file', 'input', '',
                    'Корень SMB-папки загрузок',
                    'Пример: ' + EXAMPLE_SMB_FILE]
            ];

            params.forEach(function (item) {
                Lampa.SettingsApi.addParam({
                    component: 'qbit_direct',

                    param: {
                        name: item[0],
                        type: item[1],
                        values: '',
                        default: item[2]
                    },

                    field: {
                        name: item[3],
                        description: item[4]
                    }
                });
            });

            log('Настройки зарегистрированы');
        } catch (error) {
            console.error('[qBittorrent] Settings:', error);
        }
    }

    // ========================================================================
    // ПУНКТ МЕНЮ
    // ========================================================================

    function addMenuItem() {
        try {
            if (
                !window.Lampa ||
                !Lampa.Menu ||
                typeof Lampa.Menu.addButton !== 'function'
            ) {
                return;
            }

            var icon =
                '<svg viewBox="0 0 24 24" width="24" height="24">' +
                '<path fill="currentColor" d="' +
                'M12 2l3.09 6.26L22 9.27l-5 4.87' +
                ' 1.18 6.88L12 17.77l-6.18 3.25' +
                'L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
                '</svg>';

            Lampa.Menu.addButton(
                icon,
                'qBittorrent',
                function () {
                    Lampa.Controller.toggle('settings');

                    setTimeout(function () {
                        var item = document.querySelector(
                            '[data-component="qbit_direct"]'
                        );

                        if (item) item.click();
                    }, 100);
                }
            );
        } catch (error) {
            console.error('[qBittorrent] Menu:', error);
        }
    }

    // ========================================================================
    // СОЗДАНИЕ КНОПОК
    // ========================================================================

    function createButton(className, text, handler, iconSvg) {
        var button = document.createElement('div');

        button.className =
            'qbit-direct-btn ' +
            className +
            ' selector';

        button.tabIndex = 0;
        button.innerHTML = iconSvg;

        if (text) {
            var span = document.createElement('span');

            span.textContent = text;
            span.className = 'qbit-btn-text';

            button.appendChild(span);
        }

        bindPress(button, handler);

        return button;
    }

    // ========================================================================
    // КНОПКИ В КАРТОЧКЕ ТОРРЕНТА
    // ========================================================================

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) {
            console.error('[qBittorrent] Listener unavailable');
            return;
        }

        Lampa.Listener.follow('torrent', function (event) {
            try {
                if (
                    !event ||
                    event.type !== 'render' ||
                    !event.item
                ) {
                    return;
                }

                var item = event.item.jquery ?
                    event.item[0] :
                    event.item;

                if (!item) return;

                var data = event.element || {};

                var container =
                    item.querySelector('.torrent-item__right') ||
                    item.querySelector('.torrent-item') ||
                    item;

                if (
                    container.querySelector('.qbit-direct-actions')
                ) {
                    return;
                }

                var magnet =
                    extractMagnet(data) ||
                    extractMagnet(event);

                var hash =
                    extractTorrentHash(data) ||
                    extractTorrentHash(event);

                if (!hash && magnet) {
                    hash = magnetHash(magnet);
                }

                var title =
                    data.Title ||
                    data.title ||
                    data.name ||
                    data.Name ||
                    '';

                var actions = document.createElement('div');
                actions.className = 'qbit-direct-actions';

                var downloadIcon =
                    '<svg viewBox="0 0 24 24">' +
                    '<path fill="currentColor" d="' +
                    'M19 9h-4V3H9v6H5l7 7 7-7z' +
                    'M5 18v2h14v-2H5z"/>' +
                    '</svg>';

                var playIcon =
                    '<svg viewBox="0 0 24 24">' +
                    '<path fill="currentColor" d="' +
                    'M8 5v14l11-7z"/>' +
                    '</svg>';

                var deleteIcon =
                    '<svg viewBox="0 0 24 24">' +
                    '<path fill="currentColor" d="' +
                    'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z' +
                    'M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>' +
                    '</svg>';

                var folderIcon =
                    '<svg viewBox="0 0 24 24">' +
                    '<path fill="currentColor" d="' +
                    'M10 4H2v16h20V6H12l-2-2z' +
                    'M20 18H4V8h16v10z"/>' +
                    '</svg>';

                // ------------------------------------------------
                // Кнопка плеера
                // ------------------------------------------------

                var playerButton = createButton(
                    'qbit-direct-player',
                    '',
                    function () {
                        var currentHash =
                            hash ||
                            extractTorrentHash(data) ||
                            extractTorrentHash(event) ||
                            magnetHash(magnet);

                        handlePlayerButton(currentHash);
                    },
                    playIcon
                );

                playerButton.title = 'Запустить готовое видео';

                // ------------------------------------------------
                // Кнопка добавления торрента
                // ------------------------------------------------

                var addButton = createButton(
                    'qbit-direct-add',
                    'qB',
                    function () {
                        if (!requireSetup()) return;

                        if (!magnet) {
                            notify('Не найдена magnet-ссылка');
                            return;
                        }

                        if (addButton.dataset.qbitAdding === '1') {
                            return;
                        }

                        addButton.dataset.qbitAdding = '1';

                        applyProgressToButton(
                            addButton,
                            0,
                            downloadIcon
                        );

                        qbAdd(magnet, title, function (success) {
                            addButton.dataset.qbitAdding = '0';

                            if (!success) {
                                resetButtonToQb(
                                    addButton,
                                    downloadIcon
                                );
                                return;
                            }

                            if (!hash) {
                                hash = magnetHash(magnet);
                            }

                            if (!hash) {
                                notify(
                                    'Торрент добавлен, но хеш не определён'
                                );
                                return;
                            }

                            startProgressPolling(
                                addButton,
                                hash,
                                item,
                                downloadIcon
                            );
                        });
                    },
                    downloadIcon
                );

                addButton.title = 'Добавить торрент';

                // ------------------------------------------------
                // Кнопка удаления торрента
                // ------------------------------------------------

                var deleteButton = createButton(
                    'qbit-direct-delete',
                    '',
                    function () {
                        if (!requireSetup()) return;

                        var target = hash || magnet;

                        if (!target) {
                            notify('Не удалось определить торрент');
                            return;
                        }

                        qbDelete(target, function (success) {
                            if (!success) return;

                            resetButtonToQb(
                                addButton,
                                downloadIcon
                            );

                            hash = '';
                        });
                    },
                    deleteIcon
                );

                deleteButton.title = 'Удалить торрент';

                // ------------------------------------------------
                // Кнопка папки — список серий
                // ------------------------------------------------

                var folderButton = createButton(
                    'qbit-direct-folder',
                    '',
                    function () {
                        var currentHash =
                            hash ||
                            extractTorrentHash(data) ||
                            extractTorrentHash(event) ||
                            magnetHash(magnet);

                        handleFolderButton(currentHash);
                    },
                    folderIcon
                );

                folderButton.title = 'Список серий торрента';

                // ------------------------------------------------
                // Восстановление прогресса
                // ------------------------------------------------

                if (hash) {
                    restoreTorrentState(
                        addButton,
                        hash,
                        item,
                        downloadIcon
                    );
                }

                // ------------------------------------------------
                // Порядок кнопок сверху вниз:
                // qB → плеер → корзина → папка
                // ------------------------------------------------

                actions.appendChild(addButton);
                actions.appendChild(playerButton);
                actions.appendChild(deleteButton);
                actions.appendChild(folderButton);

                container.appendChild(actions);
            } catch (error) {
                console.error(
                    '[qBittorrent] render handler:',
                    error
                );
            }
        });
    }

    // ========================================================================
    // ПОДСКАЗКИ НАСТРОЕК
    // ========================================================================

    function syncSettingPlaceholders() {
        try {
            if (
                document.querySelector('.modal, .modal__content')
            ) {
                return;
            }

            SETTING_TEXT_FIELDS.forEach(function (name) {
                var item = document.querySelector(
                    '[data-name="' + name + '"]'
                );

                if (!item) return;

                var valueEl =
                    item.querySelector('.value') ||
                    item.querySelector('.setting__value');

                if (!valueEl) return;

                var stored = String(storeGet(name, ''));

                if (stored) {
                    if (valueEl.textContent !== stored) {
                        valueEl.textContent = stored;
                    }

                    valueEl.classList.remove('qbit-empty-value');
                } else if (valueEl.textContent !== 'Не заполнено') {
                    valueEl.textContent = 'Не заполнено';
                    valueEl.classList.add('qbit-empty-value');
                }
            });
        } catch (error) {}
    }

    // ========================================================================
    // СТИЛИ
    // ========================================================================

    function addStyles() {
        if (document.getElementById('qbit-direct-style')) {
            return;
        }

        var style = document.createElement('style');
        style.id = 'qbit-direct-style';

        style.textContent =
            '.torrent-item, .torrent-item__right {' +
                'position:relative;' +
                'margin-right:32px !important;' +
            '}' +

            '.qbit-direct-actions {' +
                'display:flex;' +
                'flex-direction:column;' +
                'justify-content:center;' +
                'align-items:center;' +
                'position:absolute;' +
                'right:-28px;' +
                'top:0;' +
                'bottom:0;' +
                'z-index:999;' +
                'gap:6px;' +
            '}' +

            '.qbit-direct-btn {' +
                'display:flex;' +
                'flex-direction:column;' +
                'align-items:center;' +
                'justify-content:center;' +
                'width:24px;' +
                'height:24px;' +
                'background:none !important;' +
                'border:none !important;' +
                'border-radius:0 !important;' +
                'padding:0;' +
                'cursor:pointer;' +
                'box-sizing:border-box;' +
                'transition:transform 0.2s;' +
            '}' +

            '.qbit-direct-btn.focus {' +
                'transform:scale(1.15);' +
                'outline:none;' +
            '}' +

            '.qbit-direct-btn svg {' +
                'width:20px;' +
                'height:20px;' +
                'fill:#27ae60;' +
            '}' +

            '.qbit-btn-text {' +
                'font-size:8px;' +
                'font-weight:bold;' +
                'margin-top:-2px;' +
                'line-height:1;' +
                'color:#27ae60;' +
            '}' +

            '.qbit-direct-player svg {' +
                'fill:#3498db;' +
            '}' +

            '.qbit-direct-delete svg {' +
                'fill:#e74c3c;' +
            '}' +

            '.qbit-direct-folder svg {' +
                'fill:#e6b94a;' +
            '}' +

            '.qbit-loading {' +
                'opacity:0.7;' +
            '}' +

            '.qbit-done {' +
                'opacity:1;' +
            '}' +

            '.qbit-done .qbit-btn-text {' +
                'font-size:9px;' +
                'color:#27ae60;' +
            '}' +

            '.qbit-empty-value {' +
                'opacity:0.5 !important;' +
                'font-style:italic;' +
            '}' +

            '.qbit-files {' +
                'width:100%;' +
                'max-height:75vh;' +
                'overflow-y:auto;' +
                'box-sizing:border-box;' +
                'padding:16px;' +
            '}' +

            '.qbit-files__header {' +
                'margin-bottom:14px;' +
            '}' +

            '.qbit-files__torrent {' +
                'font-size:15px;' +
                'font-weight:bold;' +
                'margin-bottom:6px;' +
                'overflow-wrap:anywhere;' +
            '}' +

            '.qbit-files__summary {' +
                'font-size:13px;' +
                'opacity:0.8;' +
                'margin-bottom:5px;' +
            '}' +

            '.qbit-files__hint {' +
                'font-size:12px;' +
                'opacity:0.6;' +
            '}' +

            '.qbit-files__list {' +
                'overflow-y:auto;' +
                'max-height:52vh;' +
                'padding-right:4px;' +
            '}' +

            '.qbit-file {' +
                'display:flex;' +
                'flex-direction:column;' +
                'gap:9px;' +
                'padding:12px 0;' +
                'border-top:1px solid rgba(128,128,128,0.25);' +
            '}' +

            '.qbit-file__name {' +
                'font-size:14px;' +
                'font-weight:bold;' +
                'overflow-wrap:anywhere;' +
            '}' +

            '.qbit-file__episode {' +
                'font-size:12px;' +
                'opacity:0.7;' +
                'margin-top:3px;' +
            '}' +

            '.qbit-file__meta {' +
                'font-size:12px;' +
                'opacity:0.7;' +
                'margin-top:5px;' +
            '}' +

            '.qbit-file__progress {' +
                'height:4px;' +
                'background:rgba(128,128,128,0.25);' +
                'border-radius:4px;' +
                'overflow:hidden;' +
                'margin-top:7px;' +
            '}' +

            '.qbit-file__progress div {' +
                'height:100%;' +
                'background:#27ae60;' +
                'transition:width 0.3s;' +
            '}' +

            '.qbit-file__actions {' +
                'display:flex;' +
                'flex-wrap:wrap;' +
                'gap:7px;' +
            '}' +

            '.qbit-file__button, .qbit-files__refresh {' +
                'border:0;' +
                'border-radius:5px;' +
                'padding:8px 12px;' +
                'font-size:12px;' +
                'color:#fff;' +
                'background:#555;' +
                'cursor:pointer;' +
            '}' +

            '.qbit-file__button.focus, ' +
            '.qbit-files__refresh.focus {' +
                'outline:2px solid #27ae60;' +
                'outline-offset:2px;' +
            '}' +

            '.qbit-file__play {' +
                'background:#2878b9;' +
            '}' +

            '.qbit-file__button:disabled {' +
                'opacity:0.35;' +
            '}' +

            '.qbit-files__footer {' +
                'padding-top:12px;' +
                'border-top:1px solid rgba(128,128,128,0.25);' +
            '}' +

            '.qbit-files__refresh {' +
                'background:#555;' +
                'width:100%;' +
                'padding:10px;' +
            '}' +

            '.qbit-wizard {' +
                'padding:20px;' +
            '}' +

            '.qbit-wizard__desc {' +
                'font-size:14px;' +
                'margin-bottom:14px;' +
            '}' +

            '.qbit-wizard__field {' +
                'margin-bottom:12px;' +
            '}' +

            '.qbit-wizard__field label {' +
                'display:block;' +
                'font-size:12px;' +
                'margin-bottom:4px;' +
                'opacity:0.7;' +
            '}' +

            '.qbit-wizard__field input {' +
                'width:100%;' +
                'padding:8px 10px;' +
                'font-size:14px;' +
                'box-sizing:border-box;' +
                'border-radius:6px;' +
                'border:1px solid rgba(255,255,255,0.2);' +
                'background:rgba(255,255,255,0.08);' +
                'color:inherit;' +
            '}' +

            '.qbit-wizard__hint {' +
                'font-size:11px;' +
                'margin-top:4px;' +
                'opacity:0.5;' +
            '}' +

            '.qbit-wizard__actions {' +
                'display:flex;' +
                'gap:10px;' +
                'margin-top:16px;' +
            '}' +

            '.qbit-wizard__btn {' +
                'padding:10px 18px;' +
                'font-size:14px;' +
                'border-radius:6px;' +
                'border:1px solid rgba(255,255,255,0.2);' +
                'background:rgba(255,255,255,0.1);' +
                'color:inherit;' +
                'cursor:pointer;' +
            '}' +

            '.qbit-wizard__save {' +
                'background:#27ae60;' +
                'border-color:#27ae60;' +
                'color:#fff;' +
            '}';

        document.head.appendChild(style);
    }

    // ========================================================================
    // ИНИЦИАЛИЗАЦИЯ
    // ========================================================================

    function initializePlugin() {
        try {
            log('Инициализация плагина...');

            registerSettings();
            addMenuItem();
            initTorrentButton();
            addStyles();
            syncSettingPlaceholders();

            setInterval(syncSettingPlaceholders, 1500);

            log('Путь загрузки:', cfg().savepath || '(не задан)');
            log('SMB:', cfg().smb_file || '(не задан)');
            log('Внешний плеер:', cfg().external_player);
            log('Пакет плеера:', cfg().player_package);

            log('contentLayout: NoSubfolder');
            log('Управление отдельными файлами включено');
            log('Кнопка папки для списка серий включена');
            log('Навигация пультом в окне файлов включена');
            log('Плагин загружен');
        } catch (error) {
            console.error(
                '[qBittorrent] Initialization:',
                error
            );
        }
    }

    // ========================================================================
    // ЗАПУСК
    // ========================================================================

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        var initialized = false;

        function initOnce() {
            if (initialized) return;

            if (!window.Lampa || !Lampa.Listener) {
                return;
            }

            initialized = true;
            initializePlugin();
        }

        document.addEventListener('appready', initOnce);

        setTimeout(function () {
            initOnce();

            if (!initialized) {
                log('Lampa недоступна после таймаута ожидания');
            }
        }, 5000);
    }

})();    
