// ============================================================================
// qBittorrent для Lampa — Keenetic + Entware + SMB
// Управление отдельными файлами внутри торрента
// Android TV / Google TV / Android
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
    var VERIFY_INTERVAL = 1500;
    var VERIFY_ATTEMPTS = 40;

    var METADATA_ATTEMPTS = 80;
    var METADATA_INTERVAL = 1500;

    var nativeRequestId = 0;
    var sid = '';
    var loggedIn = false;
    var loginInProgress = false;
    var loginCallbacks = [];

    var activeFileModalHash = '';
    var fileModalRequestId = 0;
    var activeFileKeyHandler = null;

    var metadataWaits = {};

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
        console.error('[qBittorrent] PROMISE ERROR:', event.reason);
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
    // ИДЕНТИФИКАТОР ФАЙЛА qBittorrent
    // ========================================================================

    function getFileId(file) {
        if (!file) return null;

        if (
            file.index !== undefined &&
            file.index !== null &&
            file.index !== ''
        ) {
            return file.index;
        }

        if (
            file.id !== undefined &&
            file.id !== null &&
            file.id !== ''
        ) {
            return file.id;
        }

        return null;
    }

    function findTorrentFile(files, id) {
        if (!Array.isArray(files)) return null;
        if (id === undefined || id === null || id === '') return null;

        for (var i = 0; i < files.length; i++) {
            var currentId = getFileId(files[i]);

            if (
                currentId !== null &&
                String(currentId) === String(id)
            ) {
                return files[i];
            }
        }

        return null;
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

    function extractMagnet(data, depth) {
        depth = depth || 0;

        if (!data || depth > 5) return '';

        if (typeof data === 'string') {
            return /^magnet:\?/i.test(data) ? data : '';
        }

        if (typeof data !== 'object') return '';

        var fields = [
            'MagnetUri', 'magnetUri', 'magnet_uri',
            'magnet', 'Magnet', 'url',
            'torrent_url', 'torrentUrl', 'link',
            'Link', 'Torrent', 'torrent'
        ];

        for (var i = 0; i < fields.length; i++) {
            var value = data[fields[i]];

            if (
                typeof value === 'string' &&
                /^magnet:\?/i.test(value)
            ) {
                return value;
            }

            if (value && typeof value === 'object') {
                var nestedMagnet = extractMagnet(value, depth + 1);
                if (nestedMagnet) return nestedMagnet;
            }
        }

        var nested = [
            'item', 'data', 'element',
            'source', 'model', 'card'
        ];

        for (var j = 0; j < nested.length; j++) {
            if (data[nested[j]]) {
                var result = extractMagnet(
                    data[nested[j]],
                    depth + 1
                );

                if (result) return result;
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
            'InfoHash', 'infohash_v1', 'infoHashV1', 'btih',
            'torrent_hash', 'torrentHash'
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
            fieldHtml('qbit-wz-url', 'Адрес сервера', config.url, EXAMPLE_URL) +
            fieldHtml('qbit-wz-savepath', 'Путь загрузок на роутере', config.savepath, EXAMPLE_SAVEPATH) +
            fieldHtml('qbit-wz-smb', 'SMB-шара', config.smb_file, EXAMPLE_SMB_FILE) +
            '<div class="qbit-wizard__actions">' +
                '<button class="qbit-wizard__btn qbit-wizard__save selector" tabindex="0">Сохранить</button>' +
                '<button class="qbit-wizard__btn qbit-wizard__cancel selector" tabindex="0">Отмена</button>' +
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

                var url = html.querySelector('#qbit-wz-url').value.trim();
                var savepath = html.querySelector('#qbit-wz-savepath').value.trim();
                var smb = html.querySelector('#qbit-wz-smb').value.trim();

                if (!url || !savepath || !smb) {
                    notify('Заполните все три поля');
                    return;
                }

                storeSet('qbit_url', url);
                storeSet('qbit_savepath', savepath);
                storeSet('qbit_smb_file', smb);

                close();
                notify('Настройки сохранены');

                if (typeof onDone === 'function') onDone();
            }
        );
    }

    // ========================================================================
    // HTTP — НОРМАЛИЗАЦИЯ ОТВЕТА
    // ========================================================================

    function normalizeResponse(response) {
        if (response === null || response === undefined) return null;

        if (typeof response === 'string') return response;

        // Пустой массив AndroidJS часто означает:
        // «ответ ещё не готов», а не реальный ответ сервера.
        if (Array.isArray(response)) {
            if (!response.length) return null;

            try {
                return JSON.stringify(response);
            } catch (error) {
                return null;
            }
        }

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

            if (
                response.status !== undefined &&
                response.status >= 200 &&
                response.status < 300
            ) {
                return '';
            }

            try {
                return JSON.stringify(response);
            } catch (error) {
                return null;
            }
        }

        return String(response);
    }

    // ========================================================================
    // HTTP — ЕДИНЫЙ РЕЗЕРВНЫЙ XHR
    // ========================================================================

    function xhrRequest(request, callback) {
        var completed = false;
        var xhr;

        function finish(response) {
            if (completed) return;

            completed = true;

            if (typeof callback === 'function') {
                callback(response);
            }
        }

        try {
            if (typeof XMLHttpRequest === 'undefined') {
                finish(null);
                return;
            }

            xhr = new XMLHttpRequest();

            xhr.open(
                request.method || 'GET',
                request.url,
                true
            );

            xhr.timeout = request.timeout || 20000;
            xhr.withCredentials = true;

            var headers = request.headers || {};

            Object.keys(headers).forEach(function (name) {
                try {
                    xhr.setRequestHeader(name, headers[name]);
                } catch (error) {
                    log('Не удалось установить HTTP-заголовок:', name, error);
                }
            });

            xhr.onload = function () {
                var status = Number(xhr.status) || 0;

                if (status >= 200 && status < 300) {
                    // Пустой ответ POST-запроса qBittorrent — успех.
                    finish(
                        typeof xhr.responseText === 'string' ?
                            xhr.responseText : ''
                    );
                } else {
                    console.error(
                        '[qBittorrent] XHR HTTP error:',
                        status,
                        xhr.responseText
                    );

                    finish(null);
                }
            };

            xhr.onerror = function () {
                console.error('[qBittorrent] XHR network error');
                finish(null);
            };

            xhr.ontimeout = function () {
                console.error('[qBittorrent] XHR timeout');
                finish(null);
            };

            xhr.onabort = function () {
                finish(null);
            };

            xhr.send(
                request.body !== undefined && request.body !== null ?
                    String(request.body) : null
            );
        } catch (error) {
            console.error('[qBittorrent] XHR exception:', error);
            finish(null);
        }
    }

    // ========================================================================
    // HTTP — FETCH РЕЗЕРВ
    // ========================================================================

    function fetchRequest(request, callback) {
        var completed = false;

        function finish(response) {
            if (completed) return;
            completed = true;

            if (typeof callback === 'function') {
                callback(response);
            }
        }

        if (typeof fetch !== 'function') {
            xhrRequest(request, finish);
            return;
        }

        var options = {
            method: request.method || 'GET',
            headers: request.headers || CT_FORM,
            credentials: 'include'
        };

        if (request.body !== undefined && request.body !== null) {
            options.body = String(request.body);
        }

        fetch(request.url, options)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                return response.text();
            })
            .then(function (text) {
                finish(text);
            })
            .catch(function (error) {
                console.error('[qBittorrent] fetch:', error);
                xhrRequest(request, finish);
            });
    }

    // ========================================================================
    // HTTP — ANDROIDJS С КОРРЕКТНЫМ ОЖИДАНИЕМ ОТВЕТА
    // ========================================================================

    function nativeRequest(request, callback) {
        var finished = false;
        var requestId = ++nativeRequestId;

        var payload = {
            url: request.url,
            timeout: request.timeout || 20000,
            headers: request.headers || {}
        };

        if (request.body !== undefined && request.body !== null) {
            payload.post_data = String(request.body);
        }

        function finish(response) {
            if (finished) return;

            finished = true;

            if (typeof callback === 'function') {
                callback(response);
            }
        }

        function fallback() {
            if (finished) return;

            // Не закрываем общий callback до завершения резервного запроса.
            log('AndroidJS не вернул ответ. Переключаюсь на HTTP-резерв.');

            fetchRequest(request, function (response) {
                finish(response);
            });
        }

        if (
            !window.AndroidJS ||
            typeof window.AndroidJS.httpReq !== 'function' ||
            typeof window.AndroidJS.getResp !== 'function'
        ) {
            log('AndroidJS HTTP недоступен. Использую HTTP-резерв.');
            fetchRequest(request, finish);
            return;
        }

        try {
            window.AndroidJS.httpReq(
                JSON.stringify(payload),
                requestId
            );
        } catch (error) {
            console.error('[qBittorrent] AndroidJS.httpReq:', error);
            fetchRequest(request, finish);
            return;
        }

        var tries = 0;
        var maxTries = 150;

        (function poll() {
            if (finished) return;

            tries++;

            var response = null;

            try {
                response = window.AndroidJS.getResp(
                    String(requestId)
                );
            } catch (error) {
                log('AndroidJS.getResp:', error);
            }

            // Пустой массив — нет готового ответа.
            // Не превращаем его в строку "[]".
            if (
                response !== null &&
                response !== undefined &&
                !(Array.isArray(response) && response.length === 0)
            ) {
                var normalized = normalizeResponse(response);

                if (normalized !== null) {
                    // Пустая строка допустима как успешный HTTP-ответ:
                    // например, qBittorrent POST /resume и /filePrio.
                    finish(normalized);
                    return;
                }
            }

            if (tries >= maxTries) {
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
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        if (sid) {
            headers.Cookie = 'SID=' + sid;
        }

        return headers;
    }

    function doLogin(done) {
        var config = cfg();

        if (config.bypass || !config.user) {
            loggedIn = true;
            done(true);
            return;
        }

        if (loginInProgress) {
            loginCallbacks.push(done);
            return;
        }

        loginInProgress = true;
        loginCallbacks = [done];

        nativeRequest({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body:
                'username=' + encodeURIComponent(config.user) +
                '&password=' + encodeURIComponent(config.pass),
            headers: CT_FORM
        }, function (response) {
            var success = (
                response !== null &&
                response !== undefined &&
                !/Forbidden|403|Fails/i.test(String(response)) &&
                /^Ok\./i.test(String(response).trim())
            );

            if (success) {
                var cookieMatch = /SID=([^;\s]+)/i.exec(
                    String(response)
                );

                if (cookieMatch) {
                    sid = cookieMatch[1];
                }

                loggedIn = true;
            } else {
                loggedIn = false;
                sid = '';

                console.error(
                    '[qBittorrent] Login failed:',
                    response
                );
            }

            loginInProgress = false;

            var callbacks = loginCallbacks.slice();
            loginCallbacks = [];

            callbacks.forEach(function (callback) {
                try {
                    callback(success);
                } catch (error) {
                    console.error(
                        '[qBittorrent] login callback:',
                        error
                    );
                }
            });

            if (!success) {
                notify('Ошибка авторизации qBittorrent');
            }
        });
    }

    function qbRequest(request, callback) {
        var config = cfg();

        if (config.bypass || !config.user) {
            nativeRequest(request, callback);
            return;
        }

        function send() {
            request.headers = authHeaders();
            nativeRequest(request, callback);
        }

        if (!loggedIn) {
            doLogin(function (success) {
                if (!success) {
                    callback(null);
                    return;
                }

                send();
            });

            return;
        }

        send();
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

    function buildAddBody(magnet, title, paused) {
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
        params.push('paused=' + (paused ? 'true' : 'false'));
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
                verifyTorrentAdded(
                    hash,
                    attempt + 1,
                    callback
                );
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
            buildAddBody(magnet, title, false),
            function (response) {
                if (response === null || response === undefined) {
                    notify('Нет связи с qBittorrent');
                    if (onComplete) onComplete(false);
                    return;
                }

                if (/Forbidden|403|Errored/i.test(String(response))) {
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
    // ПРОВЕРКА УСПЕШНОСТИ POST-ЗАПРОСА
    // ========================================================================

    function isSuccessfulPost(response) {
        if (response === null || response === undefined) {
            return false;
        }

        var text = String(response).trim();

        if (/Forbidden|403|Fails|Errored|Unauthorized/i.test(text)) {
            return false;
        }

        // qBittorrent обычно отвечает пустым телом на успешные POST.
        return true;
    }

    // ========================================================================
    // ВОЗОБНОВЛЕНИЕ И ПАУЗА ТОРРЕНТА
    // ========================================================================

    function resumeTorrent(hash, callback) {
        qbPost(
            '/api/v2/torrents/resume',
            'hashes=' + encodeURIComponent(hash),
            function (response) {
                var success = isSuccessfulPost(response);

                if (!success) {
                    notify('Не удалось запустить загрузку торрента');
                    log('Ошибка resume:', response);
                } else {
                    log('Команда resume отправлена:', hash);
                }

                if (callback) callback(success, response);
            }
        );
    }

    function pauseTorrent(hash, callback) {
        qbPost(
            '/api/v2/torrents/pause',
            'hashes=' + encodeURIComponent(hash),
            function (response) {
                var success = isSuccessfulPost(response);

                if (!success) {
                    log('Не удалось поставить торрент на паузу:', response);
                } else {
                    log('Команда pause отправлена:', hash);
                }

                if (callback) callback(success, response);
            }
        );
    }

    function isTorrentPaused(torrent) {
        if (!torrent) return false;

        var state = String(torrent.state || '').toLowerCase();

        // queuedDL и queuedUP — состояния очереди, а не пауза.
        return (
            state.indexOf('paused') === 0 ||
            state.indexOf('stopped') === 0 ||
            state === 'stalleddl' && torrent.paused === true
        );
    }

    // ========================================================================
    // ДОБАВЛЕНИЕ ТОРРЕНТА ДЛЯ КНОПКИ «ПАПКА»
    // ========================================================================

    function qbAddPaused(magnet, title, callback) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('В карточке нет magnet-ссылки');
            callback(false);
            return;
        }

        var hash = magnetHash(magnet);

        if (!hash) {
            notify('Не удалось извлечь хеш из magnet-ссылки');
            callback(false);
            return;
        }

        getTorrentInfo(hash, function (existingTorrent) {
            if (existingTorrent) {
                log('Торрент уже существует, повторно не добавляю');

                waitForTorrentMetadata(
                    hash,
                    0,
                    callback,
                    { pauseOnReady: false }
                );

                return;
            }

            notify('Добавляю торрент и получаю метаданные...');

            // Magnet сначала добавляется активным для получения metadata.
            // После получения списка файлов загрузка будет остановлена.
            qbPost(
                '/api/v2/torrents/add',
                buildAddBody(magnet, title, false),
                function (response) {
                    if (response === null || response === undefined) {
                        notify('Нет ответа от qBittorrent');
                        callback(false);
                        return;
                    }

                    if (/Forbidden|403|Errored/i.test(String(response))) {
                        notify('Ошибка добавления торрента: ' + response);
                        callback(false);
                        return;
                    }

                    log('Торрент добавлен для получения metadata:', response);

                    waitForTorrentMetadata(
                        hash,
                        0,
                        callback,
                        { pauseOnReady: true }
                    );
                }
            );
        });
    }
        // ========================================================================
    // ОЖИДАНИЕ ТОРРЕНТА И METADATA
    // ========================================================================

    function finishMetadataWait(hash, success, torrent, files) {
        var key = String(hash || '').toLowerCase();
        var state = metadataWaits[key];

        if (!state || state.finished) return;

        state.finished = true;
        delete metadataWaits[key];

        var callbacks = state.callbacks.slice();
        state.callbacks = [];

        log(
            'Ожидание метаданных завершено:',
            key,
            'успех:',
            success,
            'файлов:',
            files ? files.length : 0
        );

        callbacks.forEach(function (callback) {
            try {
                callback(
                    success,
                    torrent || null,
                    files || null
                );
            } catch (error) {
                console.error(
                    '[qBittorrent] metadata callback:',
                    error
                );
            }
        });
    }

    function waitForTorrentMetadata(hash, attempt, callback, options) {
        hash = String(hash || '').trim().toLowerCase();
        attempt = Number(attempt) || 0;
        options = options || {};

        if (!hash) {
            if (typeof callback === 'function') callback(false);
            return;
        }

        var key = hash;

        if (metadataWaits[key]) {
            if (typeof callback === 'function') {
                metadataWaits[key].callbacks.push(callback);
            }

            if (options.pauseOnReady) {
                metadataWaits[key].pauseOnReady = true;
            }

            log('Ожидание уже выполняется для:', hash);
            return;
        }

        metadataWaits[key] = {
            callbacks: typeof callback === 'function' ? [callback] : [],
            finished: false,
            attempt: attempt,
            pauseOnReady: !!options.pauseOnReady,
            resumedForMetadata: false,
            resuming: false,
            pausing: false
        };

        notify('Получаю список серий...');

        function retry(reason) {
            var state = metadataWaits[key];

            if (!state || state.finished) return;

            state.attempt++;

            log(
                'Метаданные ещё не готовы:',
                reason,
                'попытка:',
                state.attempt,
                'из:',
                METADATA_ATTEMPTS
            );

            if (state.attempt >= METADATA_ATTEMPTS) {
                finishMetadataWait(key, false, null, null);

                notify(
                    'Не удалось получить список файлов. ' +
                    'Проверьте подключение и повторите попытку.'
                );

                return;
            }

            setTimeout(function () {
                checkMetadata();
            }, METADATA_INTERVAL);
        }

        function finishWithFiles(torrent, files) {
            var state = metadataWaits[key];

            if (!state || state.finished) return;

            if (!state.pauseOnReady) {
                finishMetadataWait(key, true, torrent, files);
                return;
            }

            if (state.pausing) return;

            state.pausing = true;

            pauseTorrent(key, function (paused) {
                var latest = metadataWaits[key];

                if (!latest || latest.finished) return;

                latest.pausing = false;

                if (!paused) {
                    log(
                        'Предупреждение: не удалось остановить торрент',
                        key
                    );
                }

                finishMetadataWait(
                    key,
                    true,
                    torrent,
                    files
                );
            });
        }

        function checkMetadata() {
            var state = metadataWaits[key];

            if (!state || state.finished) return;

            getTorrentInfo(key, function (torrent) {
                var current = metadataWaits[key];

                if (!current || current.finished) return;

                if (!torrent) {
                    retry('торрент пока не найден');
                    return;
                }

                var hasMetadata =
                    torrent.has_metadata !== undefined ?
                        torrent.has_metadata :
                        torrent.hasMetadata;

                var metadataMissing = (
                    hasMetadata === false ||
                    String(torrent.state || '').toLowerCase() === 'metadl'
                );

                // Если magnet остановлен без metadata, запускаем его.
                if (
                    metadataMissing &&
                    isTorrentPaused(torrent) &&
                    !current.resuming
                ) {
                    current.resuming = true;

                    log(
                        'Торрент остановлен без metadata. Возобновляю:',
                        torrent.state
                    );

                    resumeTorrent(key, function (success) {
                        var latest = metadataWaits[key];

                        if (!latest || latest.finished) return;

                        latest.resuming = false;

                        if (success) {
                            latest.resumedForMetadata = true;
                            latest.pauseOnReady = true;
                        }

                        retry(
                            success ?
                                'возобновлён, ожидаю metadata' :
                                'не удалось возобновить торрент'
                        );
                    });

                    return;
                }

                if (metadataMissing) {
                    retry('qBittorrent получает metadata magnet');
                    return;
                }

                requestTorrentFiles(key, 0, function (files) {
                    var latestState = metadataWaits[key];

                    if (!latestState || latestState.finished) return;

                    if (
                        Array.isArray(files) &&
                        files.length > 0
                    ) {
                        log(
                            'Метаданные получены:',
                            torrent.name,
                            'файлов:',
                            files.length
                        );

                        finishWithFiles(torrent, files);
                        return;
                    }

                    if (
                        isTorrentPaused(torrent) &&
                        !latestState.resuming
                    ) {
                        latestState.resuming = true;

                        log(
                            'Список файлов пуст, торрент остановлен. ' +
                            'Пробую возобновить:',
                            torrent.state
                        );

                        resumeTorrent(key, function (success) {
                            var currentState = metadataWaits[key];

                            if (!currentState || currentState.finished) return;

                            currentState.resuming = false;

                            if (success) {
                                currentState.resumedForMetadata = true;
                                currentState.pauseOnReady = true;
                            }

                            retry(
                                success ?
                                    'ожидание файлов после возобновления' :
                                    'не удалось возобновить торрент'
                            );
                        });

                        return;
                    }

                    retry('список файлов пока пуст');
                });
            });
        }

        checkMetadata();
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
            '&deleteFiles=' + (cfg().delete_files ? 'true' : 'false');

        qbPost(
            '/api/v2/torrents/delete',
            body,
            function (response) {
                if (!isSuccessfulPost(response)) {
                    notify('Ошибка удаления торрента');
                    if (onComplete) onComplete(false);
                    return;
                }

                var key = String(hash).toLowerCase();

                if (metadataWaits[key]) {
                    finishMetadataWait(key, false, null, null);
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
    // ПРИОРИТЕТ ОТДЕЛЬНОГО ФАЙЛА
    // ========================================================================

    function setFilePriority(hash, fileId, priority, callback) {
        if (
            fileId === undefined ||
            fileId === null ||
            fileId === ''
        ) {
            notify('Не определён индекс файла qBittorrent');

            if (callback) callback(false, null);
            return;
        }

        var body =
            'hash=' + encodeURIComponent(hash) +
            '&id=' + encodeURIComponent(fileId) +
            '&priority=' + encodeURIComponent(priority);

        qbPost(
            '/api/v2/torrents/filePrio',
            body,
            function (response) {
                var success = isSuccessfulPost(response);

                if (!success) {
                    log(
                        'Ошибка установки приоритета:',
                        'hash:',
                        hash,
                        'fileId:',
                        fileId,
                        'priority:',
                        priority,
                        'ответ:',
                        response
                    );
                } else {
                    log(
                        'Приоритет установлен:',
                        'fileId:',
                        fileId,
                        'priority:',
                        priority
                    );
                }

                if (callback) callback(success, response);
            }
        );
    }

    // ========================================================================
    // ЗАГРУЗКА ОДНОГО ФАЙЛА — ПОСЛЕДОВАТЕЛЬНОЕ НАЗНАЧЕНИЕ ПРИОРИТЕТОВ
    // ========================================================================

    function downloadSingleFile(hash, selectedFile, allFiles, callback) {
        var selectedId = getFileId(selectedFile);

        if (selectedId === null) {
            notify('Не удалось определить индекс файла');
            if (callback) callback(false);
            return;
        }

        if (Number(selectedFile.progress) >= 0.999999) {
            notify(
                'Файл уже скачан: ' +
                fileBasename(selectedFile.name)
            );

            if (callback) callback(true);
            return;
        }

        if (!Array.isArray(allFiles) || !allFiles.length) {
            notify('Не удалось получить полный список файлов');
            if (callback) callback(false);
            return;
        }

        notify('Подготавливаю загрузку выбранной серии...');

        var index = 0;
        var wasPaused = false;
        var pauseChecked = false;
        var operationFinished = false;

        function finish(success) {
            if (operationFinished) return;

            operationFinished = true;

            if (callback) callback(success);
        }

        function setSelectedPriority() {
            setFilePriority(
                hash,
                selectedId,
                1,
                function (success) {
                    if (!success) {
                        notify(
                            'Не удалось назначить загрузку выбранного файла'
                        );

                        finish(false);
                        return;
                    }

                    // После изменения приоритетов обязательно отправляем
                    // команду resume. Пустой ответ POST считается успехом,
                    // если HTTP-транспорт получил ответ без ошибки.
                    resumeTorrent(hash, function (resumed) {
                        if (!resumed) {
                            notify(
                                'Приоритет установлен, но торрент не удалось запустить'
                            );

                            finish(false);
                            return;
                        }

                        notify(
                            'Загрузка выбрана: ' +
                            fileBasename(selectedFile.name)
                        );

                        // Проверяем, что qBittorrent принял новый приоритет.
                        setTimeout(function () {
                            getTorrentFiles(hash, function (updatedFiles) {
                                if (!updatedFiles || !updatedFiles.length) {
                                    log(
                                        'Не удалось проверить приоритет после resume'
                                    );

                                    finish(true);
                                    return;
                                }

                                var updatedSelected = findTorrentFile(
                                    updatedFiles,
                                    selectedId
                                );

                                if (
                                    updatedSelected &&
                                    Number(updatedSelected.priority) === 0
                                ) {
                                    log(
                                        'Внимание: выбранный файл имеет priority 0 после обновления'
                                    );

                                    setFilePriority(
                                        hash,
                                        selectedId,
                                        1,
                                        function (retrySuccess) {
                                            if (retrySuccess) {
                                                resumeTorrent(hash, function (retryResume) {
                                                    finish(retryResume);
                                                });
                                            } else {
                                                finish(false);
                                            }
                                        }
                                    );

                                    return;
                                }

                                finish(true);
                            });
                        }, 700);
                    });
                }
            );
        }

        function setNext() {
            if (index >= allFiles.length) {
                setSelectedPriority();
                return;
            }

            var file = allFiles[index++];
            var currentId = getFileId(file);

            if (
                currentId === null ||
                String(currentId) === String(selectedId)
            ) {
                setNext();
                return;
            }

            // Уже исключённые файлы повторно не трогаем.
            if (Number(file.priority) === 0) {
                setNext();
                return;
            }

            setFilePriority(
                hash,
                currentId,
                0,
                function (success) {
                    if (!success) {
                        notify(
                            'Не удалось исключить файл: ' +
                            fileBasename(file.name)
                        );

                        finish(false);
                        return;
                    }

                    setNext();
                }
            );
        }

        // Проверяем состояние торрента перед изменением приоритетов.
        getTorrentInfo(hash, function (torrent) {
            if (torrent) {
                wasPaused = isTorrentPaused(torrent);
                pauseChecked = true;
            }

            // Если торрент активен, останавливаем его на время изменения
            // приоритетов. Если он уже остановлен, не посылаем лишний pause.
            if (pauseChecked && !wasPaused) {
                pauseTorrent(hash, function (paused) {
                    if (!paused) {
                        log(
                            'Не удалось поставить торрент на паузу перед сменой приоритетов. Продолжаю.'
                        );
                    }

                    setNext();
                });
            } else {
                setNext();
            }
        });
    }

    // ========================================================================
    // ИСКЛЮЧЕНИЕ ОДНОГО ФАЙЛА ИЗ ЗАГРУЗКИ
    // ========================================================================

    function excludeSingleFile(hash, file, callback) {
        var fileId = getFileId(file);

        if (fileId === null) {
            notify('Не удалось определить индекс файла');
            if (callback) callback(false);
            return;
        }

        if (Number(file.progress) >= 0.999999) {
            notify(
                'Файл уже скачан: ' +
                fileBasename(file.name)
            );

            if (callback) callback(true);
            return;
        }

        if (Number(file.priority) === 0) {
            notify(
                'Файл уже исключён: ' +
                fileBasename(file.name)
            );

            if (callback) callback(true);
            return;
        }

        setFilePriority(
            hash,
            fileId,
            0,
            function (success) {
                notify(
                    success ?
                        'Файл исключён из загрузки: ' +
                            fileBasename(file.name) :
                        'Не удалось изменить приоритет файла'
                );

                if (callback) callback(success);
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

        var file = cleanFsPath(fileName).replace(/^\/+/, '');

        var result = smbRoot +
            (file ? '/' + encodeSmbPath(file) : '');

        log('SMB URI:', result);
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

        if (match) {
            extension = '.' + match[1].toLowerCase();
        }

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
                    console.error(
                        '[qBittorrent] openPlayer:',
                        error
                    );

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
            console.error(
                '[qBittorrent] Lampa.Player:',
                error
            );

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
    if (!hash) {
        callback(null);
        return;
    }

    var targetHash = String(hash).trim().toLowerCase();
    var completed = false;

    function finish(torrent) {
        if (completed) return;
        completed = true;
        callback(torrent || null);
    }

    function parseTorrents(response) {
        if (
            response === null ||
            response === undefined ||
            response === ''
        ) {
            return null;
        }

        try {
            var data = typeof response === 'string' ?
                JSON.parse(response) : response;

            if (Array.isArray(data)) {
                return data;
            }

            if (data && Array.isArray(data.torrents)) {
                return data.torrents;
            }
        } catch (error) {
            log('Ошибка разбора информации о торрентах:', error);
        }

        return null;
    }

    function findByHash(torrents) {
        if (!Array.isArray(torrents)) return null;

        for (var i = 0; i < torrents.length; i++) {
            var torrent = torrents[i];

            if (
                torrent &&
                String(torrent.hash || '').trim().toLowerCase() === targetHash
            ) {
                return torrent;
            }
        }

        return null;
    }

    // Сначала ищем торрент по конкретному хешу.
    qbGet(
        '/api/v2/torrents/info?hashes=' +
        encodeURIComponent(targetHash),
        function (response) {
            var torrents = parseTorrents(response);
            var torrent = findByHash(torrents);

            if (torrent) {
                finish(torrent);
                return;
            }

            log(
                'Торрент не найден по точному запросу. ' +
                'Проверяю общий список. Хеш:',
                targetHash
            );

            // Резервный запрос: получаем весь список торрентов.
            qbGet(
                '/api/v2/torrents/info',
                function (fallbackResponse) {
                    var allTorrents = parseTorrents(fallbackResponse);
                    var found = findByHash(allTorrents);

                    if (found) {
                        log(
                            'Торрент найден резервным поиском:',
                            found.name,
                            found.hash
                        );

                        finish(found);
                        return;
                    }

                    log(
                        'Торрент не найден даже в общем списке. Хеш:',
                        targetHash
                    );

                    finish(null);
                }
            );
        }
    );
}

    function getTorrentFiles(hash, callback) {
        qbGet(
            '/api/v2/torrents/files?hash=' +
            encodeURIComponent(hash),
            function (response) {
                if (
                    response === null ||
                    response === undefined ||
                    response === ''
                ) {
                    callback(null);
                    return;
                }

                try {
                    var files = JSON.parse(response);

                    callback(
                        Array.isArray(files) ?
                            files : null
                    );
                } catch (error) {
                    console.error(
                        '[qBittorrent] files parse:',
                        error,
                        response
                    );

                    callback(null);
                }
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

        var fileProgress = Number(file.progress);

        if (!isFinite(fileProgress) || fileProgress < 0.999999) {
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
    // ПОЛУЧЕНИЕ СПИСКА ФАЙЛОВ
    // ========================================================================

    function requestTorrentFiles(hash, attempt, callback) {
        if (!hash) {
            callback(null);
            return;
        }

        qbRequest({
            url: base() +
                '/api/v2/torrents/files?hash=' +
                encodeURIComponent(hash),
            method: 'GET',
            headers: authHeaders()
        }, function (response) {
            var files = null;

            try {
                if (
                    typeof response === 'string' &&
                    response.length
                ) {
                    var parsed = JSON.parse(response);

                    if (Array.isArray(parsed)) {
                        files = parsed;
                    }
                }
            } catch (error) {
                log(
                    'Ошибка разбора списка файлов:',
                    response,
                    error
                );
            }

            if (files && files.length) {
                log('Получено файлов:', files.length);
                callback(files);
                return;
            }

            log(
                'Список файлов пока недоступен.',
                'Хеш:',
                hash,
                'ответ:',
                response
            );

            callback([]);
        });
    }

    // ========================================================================
    // ЗАКРЫТИЕ ОБРАБОТЧИКА НАВИГАЦИИ СПИСКА ФАЙЛОВ
    // ========================================================================

    function removeFileModalNavigation() {
        if (activeFileKeyHandler) {
            try {
                document.removeEventListener(
                    'keydown',
                    activeFileKeyHandler,
                    true
                );
            } catch (error) {}

            activeFileKeyHandler = null;
        }
    }

    // ========================================================================
    // ПРОКРУТКА К АКТИВНОЙ КНОПКЕ
    // ========================================================================

    function scrollFileButtonIntoView(button, container) {
        if (!button || !container) return;

        var list = container.querySelector('.qbit-files__list');
        var scrollContainer = list || container;

        try {
            var buttonRect = button.getBoundingClientRect();
            var containerRect = scrollContainer.getBoundingClientRect();

            if (
                buttonRect.top < containerRect.top ||
                buttonRect.bottom > containerRect.bottom
            ) {
                var offset =
                    buttonRect.top -
                    containerRect.top -
                    (containerRect.height / 2) +
                    (buttonRect.height / 2);

                scrollContainer.scrollTop += offset;
            }
        } catch (error) {
            try {
                button.scrollIntoView({
                    block: 'nearest',
                    inline: 'nearest'
                });
            } catch (scrollError) {}
        }
    }

    // ========================================================================
    // УПРАВЛЕНИЕ ПУЛЬТОМ ANDROID TV
    // ========================================================================

    function installFileModalNavigation(container) {
        removeFileModalNavigation();

        if (!container) return;

        function getButtons() {
            return Array.prototype.slice.call(
                container.querySelectorAll(
                    '.qbit-file__button.selector:not(:disabled), ' +
                    '.qbit-files__refresh.selector:not(:disabled)'
                )
            );
        }

        function getCurrentIndex(buttons) {
            var active = document.activeElement;

            for (var i = 0; i < buttons.length; i++) {
                if (
                    buttons[i] === active ||
                    buttons[i].classList.contains('focus')
                ) {
                    return i;
                }
            }

            return -1;
        }

        activeFileKeyHandler = function (event) {
            if (!activeFileModalHash) return;

            if (
                !document.body.contains(container) ||
                !container.querySelector('.qbit-files__list')
            ) {
                removeFileModalNavigation();
                return;
            }

            var key = event.key || '';
            var code = Number(event.keyCode || event.which || 0);

            var direction = 0;
            var page = false;
            var edge = '';

            if (
                key === 'ArrowDown' ||
                key === 'Down' ||
                code === 40 ||
                code === 20
            ) {
                direction = 1;
            } else if (
                key === 'ArrowUp' ||
                key === 'Up' ||
                code === 38 ||
                code === 19
            ) {
                direction = -1;
            } else if (
                key === 'PageDown' ||
                code === 34
            ) {
                direction = 1;
                page = true;
            } else if (
                key === 'PageUp' ||
                code === 33
            ) {
                direction = -1;
                page = true;
            } else if (key === 'Home' || code === 36) {
                edge = 'first';
            } else if (key === 'End' || code === 35) {
                edge = 'last';
            } else {
                return;
            }

            var buttons = getButtons();

            if (!buttons.length) return;

            var currentIndex = getCurrentIndex(buttons);
            var nextIndex = currentIndex;

            if (edge === 'first') {
                nextIndex = 0;
            } else if (edge === 'last') {
                nextIndex = buttons.length - 1;
            } else if (currentIndex === -1) {
                nextIndex = direction > 0 ?
                    0 : buttons.length - 1;
            } else if (page) {
                var pageStep = Math.max(
                    1,
                    Math.floor(buttons.length / 5)
                );

                nextIndex = currentIndex + direction * pageStep;
            } else {
                nextIndex = currentIndex + direction;
            }

            nextIndex = Math.max(
                0,
                Math.min(buttons.length - 1, nextIndex)
            );

            if (nextIndex === currentIndex) {
                event.preventDefault();
                event.stopPropagation();

                if (event.stopImmediatePropagation) {
                    event.stopImmediatePropagation();
                }

                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (event.stopImmediatePropagation) {
                event.stopImmediatePropagation();
            }

            var target = buttons[nextIndex];

            if (!target) return;

            try {
                target.focus();
            } catch (error) {}

            buttons.forEach(function (button) {
                button.classList.remove('focus');
            });

            target.classList.add('focus');

            scrollFileButtonIntoView(target, container);
        };

        document.addEventListener(
            'keydown',
            activeFileKeyHandler,
            true
        );
    }

    // ========================================================================
    // ФОКУС ПЕРВОЙ КНОПКИ
    // ========================================================================

    function focusFirstFileButton(container) {
        if (!container) return;

        setTimeout(function () {
            var buttons = container.querySelectorAll(
                '.qbit-file__button.selector:not(:disabled), ' +
                '.qbit-files__refresh.selector:not(:disabled)'
            );

            if (!buttons.length) return;

            try {
                buttons[0].focus();
                buttons[0].classList.add('focus');
            } catch (error) {}

            try {
                if (
                    window.Lampa &&
                    Lampa.Controller &&
                    typeof Lampa.Controller.collectionFocus === 'function'
                ) {
                    Lampa.Controller.collectionFocus(
                        false,
                        '.qbit-file__button.selector:not(:disabled), ' +
                        '.qbit-files__refresh.selector:not(:disabled)'
                    );
                }
            } catch (error) {
                log('Не удалось установить фокус:', error);
            }

            scrollFileButtonIntoView(buttons[0], container);
        }, 200);
    }

    // ========================================================================
    // ОБНОВЛЕНИЕ ОКНА ФАЙЛОВ
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

                renderTorrentFiles(
                    hash,
                    torrent,
                    files,
                    true
                );
            });
        });
    }

    // ========================================================================
    // ОТРИСОВКА СПИСКА ФАЙЛОВ
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
                    'Выберите действие для нужной серии' +
                '</div>' +
            '</div>';

        var list = '<div class="qbit-files__list">';

        videoFiles.forEach(function (file) {
            var progress = Math.max(
                0,
                Math.min(
                    100,
                    Math.floor((Number(file.progress) || 0) * 100)
                )
            );

            var ready = progress >= 100;
            var fileId = getFileId(file);
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

            var idAttribute = fileId === null ?
                '' : String(fileId);

            list +=
                '<div class="qbit-file" data-file-id="' +
                    escapeHtml(idAttribute) + '">' +

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

                        '<button type="button"' +
                            ' class="qbit-file__button qbit-file__download selector"' +
                            ' tabindex="0"' +
                            ' data-action="download"' +
                            ' data-id="' + escapeHtml(idAttribute) + '"' +
                            (fileId === null ? ' disabled' : '') + '>' +
                            (ready ? 'Выбрать' : 'Скачать') +
                        '</button>' +

                        '<button type="button"' +
                            ' class="qbit-file__button qbit-file__play selector"' +
                            ' tabindex="0"' +
                            ' data-action="play"' +
                            ' data-id="' + escapeHtml(idAttribute) + '"' +
                            (ready && fileId !== null ? '' : ' disabled') + '>' +
                            'Играть' +
                        '</button>' +

                        '<button type="button"' +
                            ' class="qbit-file__button qbit-file__exclude selector"' +
                            ' tabindex="0"' +
                            ' data-action="exclude"' +
                            ' data-id="' + escapeHtml(idAttribute) + '"' +
                            (excluded || fileId === null ? ' disabled' : '') + '>' +
                            'Исключить' +
                        '</button>' +

                    '</div>' +
                '</div>';
        });

        list += '</div>';

        var footer =
            '<div class="qbit-files__footer">' +
                '<div class="qbit-files__warning">' +
                    '«Исключить» отключает загрузку файла. ' +
                    'Уже скачанный файл физически не удаляется.' +
                '</div>' +
                '<button type="button" class="qbit-files__refresh selector" tabindex="0">' +
                    'Обновить список' +
                '</button>' +
            '</div>';

        html.innerHTML = header + list + footer;

        if (isRefresh && activeFileModalHash === hash) {
            removeFileModalNavigation();

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
                removeFileModalNavigation();

                activeFileModalHash = '';
                fileModalRequestId++;

                Lampa.Modal.close();

                if (
                    window.Lampa &&
                    Lampa.Controller &&
                    typeof Lampa.Controller.toggle === 'function'
                ) {
                    Lampa.Controller.toggle('content');
                }
            }
        });

        var $html = window.jQuery(html);

        focusFirstFileButton(html);
        installFileModalNavigation(html);

        // ------------------------------------------------
        // Скачать отдельную серию
        // ------------------------------------------------

        $html.find('[data-action="download"]').on(
            'hover:enter click',
            function (event) {
                event.preventDefault();
                event.stopPropagation();

                var id = this.getAttribute('data-id');
                var selected = findTorrentFile(files, id);

                if (!selected) {
                    notify('Файл не найден в полученном списке qBittorrent');
                    log('Не найден файл для загрузки. Индекс:', id);
                    return;
                }

                this.disabled = true;

                downloadSingleFile(
                    hash,
                    selected,
                    files,
                    function (success) {
                        if (success) {
                            setTimeout(function () {
                                refreshFileModal(hash);
                            }, 700);
                        } else {
                            // Возвращаем доступность кнопки при ошибке.
                            if (document.body.contains(this)) {
                                this.disabled = false;
                            }

                            setTimeout(function () {
                                refreshFileModal(hash);
                            }, 1000);
                        }
                    }.bind(this)
                );
            }
        );

        // ------------------------------------------------
        // Воспроизвести серию
        // ------------------------------------------------

        $html.find('[data-action="play"]').on(
            'hover:enter click',
            function (event) {
                event.preventDefault();
                event.stopPropagation();

                var id = this.getAttribute('data-id');
                var selected = findTorrentFile(files, id);

                if (!selected) {
                    notify('Файл не найден в полученном списке qBittorrent');
                    log('Не найден файл для воспроизведения. Индекс:', id);
                    return;
                }

                playTorrentFile(selected, torrent);
            }
        );

        // ------------------------------------------------
        // Исключить серию из загрузки
        // ------------------------------------------------

        $html.find('[data-action="exclude"]').on(
            'hover:enter click',
            function (event) {
                event.preventDefault();
                event.stopPropagation();

                var id = this.getAttribute('data-id');
                var selected = findTorrentFile(files, id);

                if (!selected) {
                    notify('Файл не найден в полученном списке qBittorrent');
                    log('Не найден файл для исключения. Индекс:', id);
                    return;
                }

                this.disabled = true;

                excludeSingleFile(
                    hash,
                    selected,
                    function (success) {
                        if (success) {
                            setTimeout(function () {
                                refreshFileModal(hash);
                            }, 500);
                        } else {
                            if (document.body.contains(this)) {
                                this.disabled = false;
                            }
                        }
                    }.bind(this)
                );
            }
        );

        // ------------------------------------------------
        // Обновить список серий
        // ------------------------------------------------

        $html.find('.qbit-files__refresh').on(
            'hover:enter click',
            function (event) {
                event.preventDefault();
                event.stopPropagation();

                removeFileModalNavigation();
                refreshFileModal(hash);
            }
        );
    }
        // ========================================================================
    // КНОПКА «ПАПКА»
    // ========================================================================

    function handleFolderButton(hash, magnet, title) {
        magnet = magnet || '';
        title = title || '';

        if (!hash && magnet) {
            hash = magnetHash(magnet);
        }

        if (!magnet && hash) {
            magnet = 'magnet:?xt=urn:btih:' + hash;
        }

        if (!hash && magnet) {
            hash = magnetHash(magnet);
        }

        if (!hash) {
            notify('Не удалось определить хеш торрента');
            log('Нет hash и magnet для кнопки «Папка»');
            return;
        }

        if (!requireSetup()) return;

        hash = String(hash).toLowerCase();

        log('Кнопка «Папка». Хеш:', hash);
        log('Magnet найден:', !!magnet);

        debugNotify('Проверяю торрент в qBittorrent...');

        getTorrentInfo(hash, function (torrent) {
            if (torrent) {
                log(
                    'Торрент уже находится в qBittorrent:',
                    torrent.name
                );

                waitForTorrentMetadata(
                    hash,
                    0,
                    function (success, readyTorrent, files) {
                        if (!success) return;

                        renderTorrentFiles(
                            hash,
                            readyTorrent || torrent,
                            files,
                            false
                        );
                    }
                );

                return;
            }

            if (!magnet) {
                notify(
                    'Торрент отсутствует в qBittorrent, ' +
                    'а magnet-ссылка не найдена'
                );

                return;
            }

            log(
                'Торрент отсутствует. Добавляю для получения metadata.'
            );

            qbAddPaused(
                magnet,
                title,
                function (success, addedTorrent, files) {
                    if (!success) return;

                    if (addedTorrent && files && files.length) {
                        renderTorrentFiles(
                            hash,
                            addedTorrent,
                            files,
                            false
                        );

                        return;
                    }

                    waitForTorrentMetadata(
                        hash,
                        0,
                        function (
                            metadataReady,
                            currentTorrent,
                            currentFiles
                        ) {
                            if (!metadataReady) return;

                            renderTorrentFiles(
                                hash,
                                currentTorrent,
                                currentFiles,
                                false
                            );
                        }
                    );
                }
            );
        });
    }

    // ========================================================================
    // КНОПКА ПЛЕЕРА — ЗАПУСК ПЕРВОГО ГОТОВОГО ВИДЕО
    // ========================================================================

    function handlePlayerButton(hash) {
        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        if (!requireSetup()) return;

        log('Хеш из карточки:', hash);
        debugNotify('Получаю информацию о торренте...');

        getTorrentInfo(hash, function (torrent) {
            if (!torrent) {
                notify('Торрент не найден в qBittorrent');
                return;
            }

            var actualHash = String(torrent.hash || hash)
                .trim()
                .toLowerCase();

            log('Хеш qBittorrent:', actualHash);
            log('Название:', torrent.name);
            log('Прогресс:', torrent.progress);

            if (Number(torrent.progress) < 0.999999) {
                notify('Торрент ещё не загружен полностью');
                return;
            }

            debugNotify('Получаю список файлов...');

            waitForTorrentMetadata(
                actualHash,
                0,
                function (success, readyTorrent, files) {
                    if (!success || !files || !files.length) return;

                    var videoFiles = files.filter(function (file) {
                        var name = String(file.name || '');

                        if (!isVideoFile(name)) return false;

                        if (Number(file.progress) < 0.999999) {
                            return false;
                        }

                        if (/sample|trailer|preview|прочее/i.test(name)) {
                            return false;
                        }

                        return true;
                    });

                    if (!videoFiles.length) {
                        notify('Нет полностью загруженных видеофайлов');
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
                if (event.preventDefault) event.preventDefault();
                if (event.stopPropagation) event.stopPropagation();

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

        applyProgressToButton(
            button,
            null,
            iconSvg
        );
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

                        applyProgressToButton(
                            button,
                            null,
                            iconSvg
                        );

                        return;
                    }

                    if (progress >= 1) {
                        stopProgressPolling(button);

                        applyProgressToButton(
                            button,
                            1,
                            iconSvg
                        );

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

                console.error(
                    '[qBittorrent] polling:',
                    error
                );
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
                applyProgressToButton(
                    button,
                    null,
                    iconSvg
                );

                return;
            }

            if (progress >= 1) {
                applyProgressToButton(
                    button,
                    1,
                    iconSvg
                );

                return;
            }

            applyProgressToButton(
                button,
                progress,
                iconSvg
            );

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
                console.error(
                    '[qBittorrent] SettingsApi unavailable'
                );

                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',

                icon:
                    '<svg viewBox="0 0 24 24" width="24">' +
                    '<path fill="currentColor" d="' +
                    'M12 2l3.09 6.26L22 9.27l-5 4.87' +
                    ' 1.18 6.88L12 17.77l-6.18 3.25' +
                    'L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
                    '</svg>',

                name: 'qBittorrent'
            });

            var params = [
                [
                    'qbit_url',
                    'input',
                    '',
                    'Адрес сервера',
                    'Пример: ' + EXAMPLE_URL
                ],

                [
                    'qbit_user',
                    'input',
                    '',
                    'Логин',
                    'Логин Web UI'
                ],

                [
                    'qbit_pass',
                    'input',
                    '',
                    'Пароль',
                    'Пароль Web UI'
                ],

                [
                    'qbit_bypass',
                    'trigger',
                    true,
                    'Обход аутентификации',
                    'Для локальной сети'
                ],

                [
                    'qbit_savepath',
                    'input',
                    '',
                    'Путь загрузки qBittorrent',
                    'Пример: ' + EXAMPLE_SAVEPATH
                ],

                [
                    'qbit_category',
                    'input',
                    '',
                    'Категория',
                    'Например: video'
                ],

                [
                    'qbit_rename',
                    'trigger',
                    true,
                    'Переименовывать торрент',
                    ''
                ],

                [
                    'qbit_confirm',
                    'trigger',
                    true,
                    'Проверять добавление',
                    'Проверять появление торрента после отправки'
                ],

                [
                    'qbit_delete_files',
                    'trigger',
                    false,
                    'Удалять файлы при удалении торрента',
                    'Применяется только при удалении всего торрента'
                ],

                [
                    'qbit_external_player',
                    'trigger',
                    true,
                    'Запускать через внешний плеер AndroidJS',
                    'Используется AndroidJS.openPlayer. ' +
                    'При выключении используется плеер Lampa'
                ],

                [
                    'qbit_player_package',
                    'input',
                    'top.rootu.dddplayer',
                    'Пакет внешнего плеера (справочно)',
                    'AndroidJS.openPlayer самостоятельно выбирает плеер'
                ],

                [
                    'qbit_smb_file',
                    'input',
                    '',
                    'Корень SMB-папки загрузок',
                    'Пример: ' + EXAMPLE_SMB_FILE
                ]
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
            console.error(
                '[qBittorrent] Settings:',
                error
            );
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
                '<svg viewBox="0 0 24 24" width="24">' +
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
            console.error(
                '[qBittorrent] Menu:',
                error
            );
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
        button.setAttribute('role', 'button');
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
            console.error(
                '[qBittorrent] Listener unavailable'
            );

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

                        if (
                            addButton.dataset.qbitAdding === '1'
                        ) {
                            return;
                        }

                        addButton.dataset.qbitAdding = '1';

                        applyProgressToButton(
                            addButton,
                            0,
                            downloadIcon
                        );

                        qbAdd(
                            magnet,
                            title,
                            function (success) {
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
                            }
                        );
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

                        qbDelete(
                            target,
                            function (success) {
                                if (!success) return;

                                resetButtonToQb(
                                    addButton,
                                    downloadIcon
                                );

                                hash = '';
                            }
                        );
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
                        var currentMagnet =
                            magnet ||
                            extractMagnet(data) ||
                            extractMagnet(event);

                        var currentHash =
                            hash ||
                            extractTorrentHash(data) ||
                            extractTorrentHash(event) ||
                            magnetHash(currentMagnet);

                        var currentTitle =
                            title ||
                            data.Title ||
                            data.title ||
                            data.name ||
                            data.Name ||
                            '';

                        handleFolderButton(
                            currentHash,
                            currentMagnet,
                            currentTitle
                        );
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
                // Порядок кнопок:
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

                    valueEl.classList.remove(
                        'qbit-empty-value'
                    );
                } else if (
                    valueEl.textContent !== 'Не заполнено'
                ) {
                    valueEl.textContent = 'Не заполнено';

                    valueEl.classList.add(
                        'qbit-empty-value'
                    );
                }
            });
        } catch (error) {}
    }

    // ========================================================================
    // СТИЛИ
    // ========================================================================

    function addStyles() {
        if (
            document.getElementById('qbit-direct-style')
        ) {
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
                'outline:2px solid rgba(255,255,255,0.8);' +
                'outline-offset:2px;' +
                'z-index:1000;' +
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

            '.qbit-direct-player svg {fill:#3498db;}' +
            '.qbit-direct-delete svg {fill:#e74c3c;}' +
            '.qbit-direct-folder svg {fill:#e6b94a;}' +
            '.qbit-loading {opacity:0.7;}' +
            '.qbit-done {opacity:1;}' +

            '.qbit-done .qbit-btn-text {' +
                'font-size:9px;' +
                'color:#27ae60;' +
            '}' +

            '.qbit-empty-value {' +
                'opacity:0.5 !important;' +
                'font-style:italic;' +
            '}' +

            // ------------------------------------------------
            // Контейнер списка файлов
            // ------------------------------------------------

            '.qbit-files {' +
                'width:100%;' +
                'height:auto;' +
                'max-height:75vh !important;' +
                'overflow-y:auto !important;' +
                'overflow-x:hidden !important;' +
                'overscroll-behavior:contain;' +
                '-webkit-overflow-scrolling:touch;' +
                'scroll-behavior:smooth;' +
                'box-sizing:border-box;' +
                'padding:16px;' +
                'outline:none;' +
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

            // ------------------------------------------------
            // Отдельная прокручиваемая область серий
            // ------------------------------------------------

            '.qbit-files__list {' +
                'display:block;' +
                'width:100%;' +
                'max-height:calc(75vh - 190px);' +
                'overflow-y:auto !important;' +
                'overflow-x:hidden !important;' +
                'overscroll-behavior:contain;' +
                '-webkit-overflow-scrolling:touch;' +
                'scroll-behavior:smooth;' +
                'box-sizing:border-box;' +
                'padding:2px 5px 8px 2px;' +
                'outline:none;' +
            '}' +

            '.qbit-file {' +
                'display:flex;' +
                'flex-direction:column;' +
                'gap:9px;' +
                'padding:12px 0;' +
                'border-top:1px solid rgba(128,128,128,0.25);' +
                'scroll-margin-top:12px;' +
                'scroll-margin-bottom:12px;' +
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
                'padding:9px 13px;' +
                'min-height:38px;' +
                'font-size:12px;' +
                'color:#fff;' +
                'background:#555;' +
                'cursor:pointer;' +
                'outline:none;' +
                'transition:transform 0.15s, box-shadow 0.15s;' +
                'scroll-margin:16px;' +
            '}' +

            '.qbit-file__button.selector, .qbit-files__refresh.selector {' +
                'position:relative;' +
                'z-index:1;' +
            '}' +

            '.qbit-file__button.focus, .qbit-files__refresh.focus {' +
                'transform:scale(1.08);' +
                'outline:3px solid #fff;' +
                'outline-offset:3px;' +
                'box-shadow:0 0 12px rgba(255,255,255,0.45);' +
                'z-index:10;' +
            '}' +

            '.qbit-file__download {background:#218c54;}' +
            '.qbit-file__play {background:#2878b9;}' +
            '.qbit-file__exclude {background:#a94442;}' +

            '.qbit-file__button:disabled {' +
                'opacity:0.35;' +
                'cursor:default;' +
                'transform:none;' +
                'outline:none;' +
                'box-shadow:none;' +
            '}' +

            '.qbit-files__footer {' +
                'padding-top:12px;' +
                'border-top:1px solid rgba(128,128,128,0.25);' +
            '}' +

            '.qbit-files__warning {' +
                'font-size:11px;' +
                'opacity:0.65;' +
                'margin-bottom:10px;' +
                'line-height:1.4;' +
            '}' +

            '.qbit-files__refresh {' +
                'background:#555;' +
                'width:100%;' +
                'padding:10px;' +
            '}' +

            // ------------------------------------------------
            // Мастер настройки
            // ------------------------------------------------

            '.qbit-wizard {padding:20px;}' +

            '.qbit-wizard__desc {' +
                'font-size:14px;' +
                'margin-bottom:14px;' +
            '}' +

            '.qbit-wizard__field {margin-bottom:12px;}' +

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

            '.qbit-wizard__btn.selector.focus {' +
                'outline:3px solid #fff;' +
                'outline-offset:3px;' +
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

            setInterval(
                syncSettingPlaceholders,
                1500
            );

            log(
                'Путь загрузки:',
                cfg().savepath || '(не задан)'
            );

            log(
                'SMB:',
                cfg().smb_file || '(не задан)'
            );

            log(
                'Внешний плеер:',
                cfg().external_player
            );

            log(
                'Пакет плеера:',
                cfg().player_package
            );

            log('contentLayout: NoSubfolder');
            log('Получение metadata magnet с последующей паузой включено');
            log('Ожидание metadata: до 120 секунд');
            log('Защита от повторных циклов ожидания включена');
            log('Загрузка выбранного файла включена');
            log('Использование index qBittorrent API включено');
            log('Навигация пультом Android TV включена');
            log('Автоматическая прокрутка списка серий включена');
            log('Исправленная обработка HTTP AndroidJS включена');
            log('Резервные HTTP-запросы fetch/XHR включены');
            log('Обработка пустых ответов POST включена');
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

        document.addEventListener(
            'appready',
            initOnce
        );

        setTimeout(function () {
            initOnce();

            if (!initialized) {
                log(
                    'Lampa недоступна после таймаута ожидания'
                );
            }
        }, 5000);
    }

})();
