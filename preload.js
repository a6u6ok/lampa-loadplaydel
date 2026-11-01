// ============================================================================
// qBittorrent для Lampa — Keenetic + Entware + SMB
// Исправленная версия
//
// Возможности:
// - Добавление magnet-ссылок в qBittorrent
// - Отображение и восстановление прогресса загрузки
// - Запуск полностью загруженных видео через плеер Lampa
// - Выбор первой серии сериала
// - Удаление торрентов
// - Формирование SMB-путей для вложенных папок
// - Настройки в Lampa.Storage
//
// DDD Player: top.rootu.dddplayer
// Запуск выполняется через штатный AndroidJS.openPlayer(link, json).
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // НАСТРОЙКИ ПО УМОЛЧАНИЮ
    // ========================================================================

    var EXAMPLE_URL = 'http://192.168.1.1:9080';
    var EXAMPLE_SAVEPATH = '/mnt/storage/torrents';
    var EXAMPLE_SMB_FILE = 'smb://192.168.1.1/MEDIA/';

    var EMPTY_LABEL = 'Не заполнено';
    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;
    var VERIFY_INTERVAL = 1000;
    var VERIFY_ATTEMPTS = 8;

    var nativeRequestId = 0;
    var sid = '';
    var loggedIn = false;

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
        } catch (error) {
            console.error('[qBittorrent] notify:', error);
        }

        console.log('[qBittorrent]', message);
    }

    function debugNotify(message) {
        if (DEBUG) notify(message);
    }

    window.addEventListener('error', function (event) {
        try {
            console.error(
                '[qBittorrent] SCRIPT ERROR:',
                event.message,
                'строка:',
                event.lineno,
                event.error
            );

            notify(
                'qBittorrent: ' + event.message +
                ' (строка ' + event.lineno + ')'
            );
        } catch (error) {}
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

            bypass: isTrue(
                storeGet('qbit_bypass', true), true
            ),

            savepath: String(
                storeGet('qbit_savepath', '') || ''
            ).trim(),

            category: String(
                storeGet('qbit_category', '') || ''
            ).trim(),

            rename: isTrue(
                storeGet('qbit_rename', true), true
            ),

            confirm: isTrue(
                storeGet('qbit_confirm', true), true
            ),

            auto_cat_path: isTrue(
                storeGet('qbit_auto_cat_path', true), true
            ),

            delete_files: isTrue(
                storeGet('qbit_delete_files', false), false
            ),

            smb_torrent_folder: isTrue(
                storeGet('qbit_smb_torrent_folder', false), false
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

    // ========================================================================
    // ПУТИ
    // ========================================================================

    function joinPath(a, b) {
        if (!a) return b || '';
        if (!b) return a;

        return String(a).replace(/\/+$/, '') +
            '/' +
            String(b).replace(/^\/+/, '');
    }

    function cleanFsPath(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/, '');
    }

    function relativeFsPath(basePath, path) {
        basePath = cleanFsPath(basePath);
        path = cleanFsPath(path);

        if (!path) return '';
        if (!basePath) return path.replace(/^\/+/, '');
        if (path === basePath) return '';

        if (path.indexOf(basePath + '/') === 0) {
            return path.substring(basePath.length + 1);
        }

        return '';
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

    function stripLocalRoots(path, config) {
        path = cleanFsPath(path);

        var roots = [];
        var savePath = cleanFsPath(config.savepath);

        if (savePath) {
            roots.push(savePath);

            if (config.category) {
                roots.push(
                    joinPath(savePath, config.category)
                );
            }
        }

        roots.sort(function (a, b) {
            return b.length - a.length;
        });

        for (var i = 0; i < roots.length; i++) {
            if (path === roots[i]) return '';

            if (path.indexOf(roots[i] + '/') === 0) {
                return path.substring(roots[i].length + 1);
            }
        }

        return path.replace(/^\/+/, '');
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
    // ФАЙЛЫ И ФОРМАТИРОВАНИЕ
    // ========================================================================

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

        return (bytes / 1024).toFixed(1) + ' KB';
    }

    // ========================================================================
    // МАСТЕР НАСТРОЙКИ
    // ========================================================================

    function openSetupWizard(onDone) {
        if (!window.Lampa || !Lampa.Modal) {
            notify('Настройки: Настройки → qBittorrent');
            return;
        }

        var config = cfg();

        function escapeAttr(value) {
            return String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        function fieldHtml(id, label, value, example) {
            return (
                '<div class="qbit-wizard__field">' +
                    '<label>' + label + '</label>' +
                    '<input type="text" id="' + id + '"' +
                    ' placeholder="' +
                    (value ? '' : EMPTY_LABEL) + '"' +
                    ' value="' + escapeAttr(value) + '">' +
                    '<div class="qbit-wizard__hint">' +
                        'Пример: ' + example +
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
            html: html,
            size: 'medium',
            onBack: function () {
                Lampa.Modal.close();
            }
        });

        function close() {
            try {
                Lampa.Modal.close();
            } catch (error) {}
        }

        var cancelButton = html.querySelector(
            '.qbit-wizard__cancel'
        );

        var saveButton = html.querySelector(
            '.qbit-wizard__save'
        );

        if (window.jQuery && cancelButton) {
            window.jQuery(cancelButton).on(
                'hover:enter click',
                close
            );
        }

        if (window.jQuery && saveButton) {
            window.jQuery(saveButton).on(
                'hover:enter click',
                function () {
                    var url = html.querySelector(
                        '#qbit-wz-url'
                    ).value.trim();

                    var savepath = html.querySelector(
                        '#qbit-wz-savepath'
                    ).value.trim();

                    var smb = html.querySelector(
                        '#qbit-wz-smb'
                    ).value.trim();

                    if (!url) {
                        notify('Укажите адрес qBittorrent');
                        return;
                    }

                    if (!savepath) {
                        notify('Укажите путь загрузок');
                        return;
                    }

                    if (!smb) {
                        notify('Укажите SMB-шару');
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
    }

    function requireSetup() {
        if (isConfigured()) return true;

        debugNotify('Требуется первая настройка');
        openSetupWizard();

        return false;
    }

    // ========================================================================
    // HTTP — НОРМАЛИЗАЦИЯ ОТВЕТА
    // ========================================================================

    function normalizeResponse(response) {
        if (response === null || response === undefined) {
            return null;
        }

        if (typeof response === 'string') {
            return response;
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

        if (
            request.body !== undefined &&
            request.body !== null &&
            request.body !== ''
        ) {
            options.body = request.body;
        }

        fetch(request.url, options)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                return response.text();
            })
            .then(function (text) {
                log(
                    'Fetch response:',
                    String(text).substring(0, 250)
                );

                callback(text);
            })
            .catch(function (error) {
                console.error(
                    '[qBittorrent] fetch error:',
                    error
                );

                callback(null);
            });
    }

    // ========================================================================
    // ANDROIDJS HTTP
    // ========================================================================

    function nativeRequest(request, callback) {
        var finished = false;
        var requestId = ++nativeRequestId;

        var payload = {
            url: request.url,
            timeout: 20000,
            headers: request.headers || {}
        };

        if (
            request.body !== undefined &&
            request.body !== null &&
            request.body !== ''
        ) {
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
            console.error(
                '[qBittorrent] httpReq error:',
                error
            );

            fetchRequest(request, callback);
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
                console.error(
                    '[qBittorrent] getResp error:',
                    error
                );
            }

            if (
                response !== null &&
                response !== undefined
            ) {
                var normalized = normalizeResponse(response);

                if (
                    normalized !== null &&
                    normalized.length > 0
                ) {
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
            'Content-Type':
                'application/x-www-form-urlencoded'
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

        nativeRequest({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body:
                'username=' +
                encodeURIComponent(config.user) +
                '&password=' +
                encodeURIComponent(config.pass),
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

            // AndroidJS может самостоятельно сохранять Cookie
            // между запросами. Если SID доступен в ответе,
            // сохраняем его для следующих обращений.
            var cookieMatch = /SID=([^;\s]+)/i.exec(
                String(response)
            );

            if (cookieMatch) {
                sid = cookieMatch[1];
            }

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

    // ========================================================================
    // ДОБАВЛЕНИЕ ТОРРЕНТА
    // ========================================================================

    function buildAddBody(magnet, title) {
        var config = cfg();

        var body = 'urls=' + encodeURIComponent(magnet);
        var finalSavePath = config.savepath;
        var autoTMM = false;

        if (config.auto_cat_path && config.category) {
            if (finalSavePath) {
                finalSavePath = joinPath(
                    finalSavePath,
                    config.category
                );
            } else {
                autoTMM = true;
            }
        }

        if (finalSavePath) {
            body += '&savepath=' +
                encodeURIComponent(finalSavePath);
        }

        if (config.category) {
            body += '&category=' +
                encodeURIComponent(config.category);
        }

        if (config.rename && title) {
            body += '&rename=' +
                encodeURIComponent(title);
        }

        body += '&paused=false';
        body += '&autoTMM=' +
            (autoTMM ? 'true' : 'false');

        return body;
    }

    function verifyTorrentAdded(hash, attempt, callback) {
        attempt = attempt || 0;

        if (!hash) {
            callback(false);
            return;
        }

        checkTorrentProgress(hash, function (progress) {
            if (progress !== null) {
                callback(true, progress);
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

        qbRequest({
            url: base() + '/api/v2/torrents/add',
            method: 'POST',
            body: buildAddBody(magnet, title),
            headers: authHeaders()
        }, function (response) {
            if (
                response === null ||
                response === undefined
            ) {
                notify('Нет связи с qBittorrent');

                if (onComplete) onComplete(false);
                return;
            }

            if (
                /Forbidden|403|Fails|Errored/i.test(response)
            ) {
                notify('Ошибка добавления торрента: ' + response);

                if (onComplete) onComplete(false);
                return;
            }

            var hash = magnetHash(magnet);

            if (!cfg().confirm) {
                notify('Отправлено в qBittorrent');

                if (onComplete) onComplete(true);
                return;
            }

            notify('Проверяю добавление торрента...');

            verifyTorrentAdded(hash, 0, function (found) {
                if (found) {
                    notify('Торрент успешно добавлен');
                } else {
                    notify(
                        'Запрос отправлен, но торрент пока не найден. ' +
                        'Проверьте список qBittorrent.'
                    );
                }

                if (onComplete) onComplete(true, found);
            });
        });
    }

    // ========================================================================
    // УДАЛЕНИЕ ТОРРЕНТА
    // ========================================================================

    function qbDelete(hashOrMagnet) {
        var hash = magnetHash(hashOrMagnet);

        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        var body =
            'hashes=' + encodeURIComponent(hash) +
            '&deleteFiles=' +
            (cfg().delete_files ? 'true' : 'false');

        debugNotify('Удаляю торрент...');

        qbRequest({
            url: base() + '/api/v2/torrents/delete',
            method: 'POST',
            body: body,
            headers: authHeaders()
        }, function (response) {
            if (
                response === null ||
                response === undefined
            ) {
                notify('Нет связи с qBittorrent');
                return;
            }

            if (/Forbidden|403|Fails/i.test(response)) {
                notify('Ошибка удаления торрента');
                return;
            }

            notify(
                cfg().delete_files ?
                'Торрент и его файлы удалены' :
                'Торрент удалён из списка'
            );
        });
    }

    // ========================================================================
    // ПРОГРЕСС ЗАГРУЗКИ
    // ========================================================================

    function checkTorrentProgress(hash, onProgress) {
        if (!hash) {
            onProgress(null);
            return;
        }

        qbRequest({
            url:
                base() +
                '/api/v2/torrents/info?hashes=' +
                encodeURIComponent(hash),
            method: 'GET',
            headers: authHeaders()
        }, function (response) {
            if (
                typeof response !== 'string' ||
                !response.length
            ) {
                onProgress(null);
                return;
            }

            try {
                var data = JSON.parse(response);

                var torrents = Array.isArray(data) ?
                    data :
                    (data.torrents || []);

                if (torrents.length) {
                    onProgress(
                        Number(torrents[0].progress) || 0
                    );
                } else {
                    onProgress(null);
                }
            } catch (error) {
                console.error(
                    '[qBittorrent] progress parse error:',
                    error
                );

                onProgress(null);
            }
        });
    }

    // ========================================================================
    // ФОРМИРОВАНИЕ SMB URI
    // ========================================================================

    function makeSmbUri(fileName, torrent) {
        var config = cfg();
        torrent = torrent || {};

        var smbRoot = String(config.smb_file || '')
            .trim()
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');

        var file = cleanFsPath(fileName);
        var configuredSave = cleanFsPath(config.savepath);

        var torrentSave = cleanFsPath(
            torrent.save_path || configuredSave
        );

        var contentPath = cleanFsPath(
            torrent.content_path || ''
        );

        var relativeBase = relativeFsPath(
            configuredSave,
            torrentSave
        );

        var contentRelative = '';

        if (contentPath && torrentSave) {
            var contentLeaf = contentPath.split('/').pop();
            var fileLeaf = file.split('/').pop();

            // Для одиночного файла content_path заканчивается
            // именем самого файла, поэтому папку добавлять нельзя.
            if (contentLeaf !== fileLeaf) {
                contentRelative = relativeFsPath(
                    torrentSave,
                    contentPath
                );
            }
        }

        // Если qBittorrent вернул абсолютный путь.
        if (/^(?:[A-Za-z]:\/|\/)/.test(file)) {
            var absoluteRelative = relativeFsPath(
                configuredSave,
                file
            );

            if (!absoluteRelative) {
                absoluteRelative = relativeFsPath(
                    torrentSave,
                    file
                );

                if (absoluteRelative) {
                    absoluteRelative = [
                        relativeBase,
                        absoluteRelative
                    ].filter(Boolean).join('/');
                }
            }

            file = absoluteRelative ||
                stripLocalRoots(file, config);

            relativeBase = '';
            contentRelative = '';
        } else {
            // В обычном режиме добавляем папку торрента,
            // если API ещё не включил её в file.name.
            if (
                contentRelative &&
                file.indexOf(contentRelative + '/') !== 0 &&
                file !== contentRelative
            ) {
                file = contentRelative + '/' + file;
            }

            if (
                relativeBase &&
                file.indexOf(relativeBase + '/') !== 0 &&
                file !== relativeBase
            ) {
                file = relativeBase + '/' + file;
            }

            // Если SMB уже указывает непосредственно
            // на папку торрента, убираем её из относительного пути.
            if (
                config.smb_torrent_folder &&
                contentRelative &&
                file.indexOf(contentRelative + '/') === 0
            ) {
                file = file.substring(
                    contentRelative.length + 1
                );
            }
        }

        file = cleanFsPath(file).replace(/^\/+/, '');

        var result = smbRoot +
            (file ? '/' + encodeSmbPath(file) : '');

        log('SMB root:', smbRoot);
        log('Torrent:', torrent.name || '');
        log('Save path:', torrentSave);
        log('Content path:', contentPath);
        log('File:', fileName);
        log('Relative path:', file);
        log('SMB URI:', result);

        return result;
    }
        // ========================================================================
    // ЗАПУСК ВИДЕО
    // ========================================================================

    function openFileInPlayer(fileUri, playerPkg, title) {
        var uri = String(fileUri || '').trim();
        var config = cfg();
        var videoTitle = title || 'qBittorrent';

        if (!uri) {
            notify('Не указан путь к видеофайлу');
            return;
        }

        var extension = '';
        var match = /\.([^.\/?#]+)(?:[?#]|$)/i.exec(uri);

        if (match) {
            extension = '.' + match[1].toLowerCase();
        }

        var playerData = {
            url: uri,
            title: videoTitle,
            source: 'qBittorrent',
            quality: 'auto',
            exe: extension
        };

        log('Запуск видео:', playerData);
        log(
            'Пакет в настройках:',
            playerPkg || config.player_package
        );

        // Штатный AndroidJS.openPlayer принимает ДВА аргумента.
        // Выбор внешнего плеера выполняется средствами Lampa.

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

                    log(
                        'Видео передано штатному AndroidJS.openPlayer'
                    );

                    return;
                } catch (error) {
                    console.error(
                        '[qBittorrent] AndroidJS.openPlayer:',
                        error
                    );

                    notify(
                        'Ошибка передачи видео: ' +
                        (error.message || error)
                    );

                    return;
                }
            }

            notify(
                'AndroidJS.openPlayer недоступен. ' +
                'Запустите Lampa на Android TV.'
            );

            return;
        }

        // Встроенный плеер Lampa.
        try {
            if (
                window.Lampa &&
                Lampa.Player &&
                typeof Lampa.Player.play === 'function'
            ) {
                Lampa.Player.play(playerData);
                log('Видео передано Lampa.Player');
                return;
            }
        } catch (error) {
            console.error(
                '[qBittorrent] Lampa.Player:',
                error
            );

            notify(
                'Ошибка встроенного плеера: ' +
                (error.message || error)
            );

            return;
        }

        notify('Не удалось запустить плеер Lampa');
    }

    // ========================================================================
    // ИНФОРМАЦИЯ О СЕРИИ
    // ========================================================================

    function getEpisodeInfo(filename) {
        var name = String(filename || '')
            .replace(/\\/g, '/')
            .split('/')
            .pop();

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

        // Файлы с определёнными номерами серий идут первыми.
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
    // ПОЛУЧЕНИЕ ФАЙЛОВ И ЗАПУСК
    // ========================================================================

    function handlePlayerButton(hash) {
        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        log('Выбран хеш:', hash);
        debugNotify('Получаю информацию о торренте...');

        qbRequest({
            url:
                base() +
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
                    return;
                }

                torrent = torrents[0];
            } catch (error) {
                console.error(
                    '[qBittorrent] info parse error:',
                    error
                );

                notify('Ошибка чтения информации о торренте');
                return;
            }

            if (Number(torrent.progress) < 0.999999) {
                notify('Торрент ещё не загружен полностью');
                return;
            }

            debugNotify('Получаю список файлов...');

            qbRequest({
                url:
                    base() +
                    '/api/v2/torrents/files?hash=' +
                    encodeURIComponent(hash),
                method: 'GET',
                headers: authHeaders()
            }, function (filesResponse) {
                if (!filesResponse) {
                    notify('Не удалось получить список файлов');
                    return;
                }

                var files;

                try {
                    files = JSON.parse(filesResponse);
                } catch (error) {
                    console.error(
                        '[qBittorrent] files parse error:',
                        error
                    );

                    notify('Ошибка чтения списка файлов');
                    return;
                }

                if (!Array.isArray(files) || !files.length) {
                    notify('В торренте нет файлов');
                    return;
                }

                // Выбираем только полностью скачанные видео.
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
                    notify('Нет полностью скачанных видеофайлов');
                    return;
                }

                // Сортировка по сезону и серии.
                videoFiles.sort(compareVideoFiles);

                var selectedFile = videoFiles[0];

                var fileTitle = String(selectedFile.name)
                    .replace(/\\/g, '/')
                    .split('/')
                    .pop();

                var smbUri = makeSmbUri(
                    selectedFile.name,
                    torrent
                );

                log('Всего видео:', videoFiles.length);
                log('Выбрана первая серия:', selectedFile.name);
                log(
                    'Информация о серии:',
                    getEpisodeInfo(selectedFile.name)
                );
                log('Размер:', formatSize(selectedFile.size));
                log('SMB URI:', smbUri);

                notify('Запускаю: ' + fileTitle);

                openFileInPlayer(
                    smbUri,
                    cfg().player_package,
                    fileTitle
                );
            });
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

        var text = '';

        if (progress === null || progress === undefined) {
            button.classList.remove(
                'qbit-loading',
                'qbit-done'
            );

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

        text = percent + '%';

        button.innerHTML = iconSvg +
            '<span class="qbit-btn-text">' +
            text +
            '</span>';
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

    function startProgressPolling(
        button,
        hash,
        item,
        iconSvg
    ) {
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
                    '[qBittorrent] polling error:',
                    error
                );
            }
        }, POLL_INTERVAL);
    }

    // ========================================================================
    // ВОССТАНОВЛЕНИЕ СОСТОЯНИЯ ТОРРЕНТА
    // ========================================================================

    function restoreTorrentState(
        button,
        hash,
        item,
        iconSvg
    ) {
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
                    '<svg viewBox="0 0 24 24" width="24" height="24">' +
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
                    'qbit_auto_cat_path',
                    'trigger',
                    true,
                    'Добавлять категорию к пути',
                    ''
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
                    'Удалять файлы торрента',
                    ''
                ],
                [
                    'qbit_external_player',
                    'trigger',
                    true,
                    'Запускать через плеер Lampa',
                    'Выберите DDD Player в настройках плеера Lampa'
                ],
                [
                    'qbit_player_package',
                    'input',
                    'top.rootu.dddplayer',
                    'Пакет внешнего плеера',
                    'DDD Player: top.rootu.dddplayer. ' +
                    'Информационное поле, само по себе не выбирает плеер'
                ],
                [
                    'qbit_smb_file',
                    'input',
                    '',
                    'Корень SMB-папки загрузок',
                    'Пример: ' + EXAMPLE_SMB_FILE
                ],
                [
                    'qbit_smb_torrent_folder',
                    'trigger',
                    false,
                    'SMB-корень уже содержит папку торрента',
                    'Включите, если SMB указывает прямо на папку торрента'
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
                '[qBittorrent] Settings error:',
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
            console.error(
                '[qBittorrent] Menu error:',
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

                log('torrent render');
                log('magnet:', magnet);
                log('hash:', hash);

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

                // ------------------------------------------------
                // КНОПКА ПЛЕЕРА
                // ------------------------------------------------

                var playerButton = createButton(
                    'qbit-direct-player',
                    '',
                    function () {
                        if (!requireSetup()) return;

                        var currentHash =
                            hash ||
                            extractTorrentHash(data) ||
                            extractTorrentHash(event) ||
                            magnetHash(magnet);

                        handlePlayerButton(currentHash);
                    },
                    playIcon
                );

                // ------------------------------------------------
                // КНОПКА УДАЛЕНИЯ
                // ------------------------------------------------

                var deleteButton = createButton(
                    'qbit-direct-delete',
                    '',
                    function () {
                        if (!requireSetup()) return;

                        var target = hash || magnet;

                        qbDelete(target);
                    },
                    deleteIcon
                );

                // ------------------------------------------------
                // КНОПКА ДОБАВЛЕНИЯ
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

                        qbAdd(magnet, title, function (success) {
                            addButton.dataset.qbitAdding = '0';

                            if (!success) {
                                applyProgressToButton(
                                    addButton,
                                    null,
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

                // Восстановление состояния кнопки.
                if (hash) {
                    restoreTorrentState(
                        addButton,
                        hash,
                        item,
                        downloadIcon
                    );
                }

                actions.appendChild(addButton);
                actions.appendChild(playerButton);
                actions.appendChild(deleteButton);

                container.appendChild(actions);
            } catch (error) {
                console.error(
                    '[qBittorrent] render handler error:',
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
                document.querySelector(
                    '.modal, .modal__content'
                )
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
                    valueEl.textContent !== EMPTY_LABEL
                ) {
                    valueEl.textContent = EMPTY_LABEL;

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

            '.qbit-wizard {' +
                'padding:20px;' +
            '}' +

            '.qbit-wizard__desc {' +
                'font-size:14px;' +
                'margin-bottom:14px;' +
                'color:inherit;' +
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
                'SMB folder mode:',
                cfg().smb_torrent_folder
            );

            log(
                'Внешний плеер:',
                cfg().external_player
            );

            log(
                'Пакет плеера:',
                cfg().player_package
            );

            log('Плагин загружен');
        } catch (error) {
            console.error(
                '[qBittorrent] Initialization error:',
                error
            );
        }
    }

    // ========================================================================
    // ЗАПУСК
    // ========================================================================

    if (
        window.Lampa &&
        Lampa.Listener
    ) {
        initializePlugin();
    } else {
        var initialized = false;

        function initOnce() {
            if (initialized) return;

            if (
                !window.Lampa ||
                !Lampa.Listener
            ) {
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
