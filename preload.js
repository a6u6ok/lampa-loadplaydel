// ============================================================================
// qBittorrent для Lampa — Keenetic + Entware + SMB
// Основа: kostya4000/lampa-qbit
//
// Возможности:
// - Добавление торрентов в qBittorrent
// - Отслеживание прогресса загрузки
// - Удаление торрентов
// - Запуск загруженных видео через встроенный плеер Lampa
// - Резервный запуск через AndroidJS
// - Поддержка автоматически создаваемых папок торрентов
// - Формирование SMB URI с сохранением вложенных каталогов
// - Мастер первоначальной настройки
// - Настройки сохраняются в Lampa.Storage
// ============================================================================

(function () {
    'use strict';

    // ================= ОБРАБОТКА ОШИБОК =================

    window.addEventListener('error', function (event) {
        try {
            console.error(
                '[qBittorrent] SCRIPT ERROR:',
                event.message,
                'строка:',
                event.lineno,
                event.error
            );

            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(
                    'qBittorrent: ' + event.message +
                    ' (строка ' + event.lineno + ')'
                );
            }
        } catch (e) {}
    });

    window.addEventListener('unhandledrejection', function (event) {
        console.error('[qBittorrent] PROMISE ERROR:', event.reason);
    });

    // ================= ПРИМЕРЫ НАСТРОЕК =================

    var EXAMPLE_URL = 'http://192.168.1.1:9080';
    var EXAMPLE_SAVEPATH = '/mnt/storage/torrents';
    var EXAMPLE_SMB_FILE = 'smb://192.168.1.1/MEDIA/';

    var EMPTY_LABEL = 'Не заполнено';

    var SETTING_TEXT_FIELDS = [
        'qbit_url',
        'qbit_user',
        'qbit_pass',
        'qbit_savepath',
        'qbit_category',
        'qbit_smb_file'
    ];

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;

    var nativeRequestId = 0;
    var sid = '';

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    var VIDEO_EXTENSIONS = [
        'mkv', 'mp4', 'avi', 'm4v', 'mov',
        'wmv', 'mpg', 'mpeg', 'ts', 'm2ts',
        'webm', 'flv', 'vob', 'ogv', '3gp'
    ];

    // ================= ЛОГИ =================

    function log() {
        if (DEBUG) {
            console.log.apply(
                console,
                ['[qBittorrent]'].concat(
                    Array.prototype.slice.call(arguments)
                )
            );
        }
    }

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (error) {
            console.error('[qBittorrent] notify error:', error);
        }

        console.log('[qBittorrent]', text);
    }

    function debugNotify(text) {
        if (DEBUG) notify(text);
    }

    // ================= ХРАНИЛИЩЕ =================

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
            url: storeGet('qbit_url', ''),
            user: storeGet('qbit_user', ''),
            pass: storeGet('qbit_pass', ''),

            bypass: isTrue(
                storeGet('qbit_bypass', true), true
            ),

            savepath: storeGet('qbit_savepath', ''),
            category: storeGet('qbit_category', ''),

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

            // Новый параметр:
            // SMB-корень уже содержит папку конкретного торрента.
            smb_torrent_folder: isTrue(
                storeGet('qbit_smb_torrent_folder', false), false
            ),

            player_package: storeGet('qbit_player_package', ''),
            smb_file: storeGet('qbit_smb_file', '')
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
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    // ================= РАБОТА С ПУТЯМИ =================

    function joinPath(a, b) {
        if (!a) return b || '';
        if (!b) return a;

        return String(a).replace(/\/+$/, '') +
            '/' +
            String(b).replace(/^\/+/, '');
    }

    // ================= MAGNET И HASH =================

    function magnetHash(magnet) {
        var value = String(magnet || '');

        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(value);

        if (match) return match[1].toLowerCase();

        value = value.trim();

        // SHA-1 infohash.
        if (/^[a-f0-9]{40}$/i.test(value)) {
            return value.toLowerCase();
        }

        // BitTorrent v2 infohash.
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
            'MagnetUri',
            'magnetUri',
            'magnet_uri',
            'magnet',
            'Magnet',
            'url',
            'torrent_url',
            'torrentUrl',
            'link'
        ];

        for (var i = 0; i < fields.length; i++) {
            if (
                typeof data[fields[i]] === 'string' &&
                /^magnet:\?/i.test(data[fields[i]])
            ) {
                return data[fields[i]];
            }
        }

        return '';
    }

    function extractTorrentHash(data, depth) {
        depth = depth || 0;

        if (!data || depth > 4) return '';

        if (typeof data === 'string') {
            return magnetHash(data);
        }

        if (typeof data !== 'object') return '';

        var direct = [
            'hash',
            'Hash',
            'infohash',
            'infoHash',
            'InfoHash',
            'infohash_v1',
            'infoHashV1',
            'btih'
        ];

        for (var i = 0; i < direct.length; i++) {
            if (data[direct[i]]) {
                var h = magnetHash(data[direct[i]]);

                if (h) return h;
            }
        }

        var magnet = extractMagnet(data);

        if (magnet) {
            var mh = magnetHash(magnet);

            if (mh) return mh;
        }

        var nested = [
            'torrent',
            'item',
            'data',
            'element',
            'source',
            'model',
            'card'
        ];

        for (var j = 0; j < nested.length; j++) {
            if (data[nested[j]]) {
                var n = extractTorrentHash(
                    data[nested[j]],
                    depth + 1
                );

                if (n) return n;
            }
        }

        return '';
    }

    // ================= ФАЙЛЫ =================

    function isVideoFile(filename) {
        var match = /\.([^.\/\\]+)$/.exec(
            String(filename || '').toLowerCase()
        );

        return match ?
            VIDEO_EXTENSIONS.indexOf(match[1]) !== -1 :
            false;
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

    // ================= ПОДСКАЗКИ НАСТРОЕК =================

    function syncSettingPlaceholders() {
        try {
            if (document.querySelector('.modal, .modal__content')) {
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
                } else if (valueEl.textContent !== EMPTY_LABEL) {
                    valueEl.textContent = EMPTY_LABEL;

                    valueEl.classList.add('qbit-empty-value');
                }
            });
        } catch (error) {}
    }

    // ================= МАСТЕР НАСТРОЙКИ =================

    function openSetupWizard(onDone) {
        if (!window.Lampa || !Lampa.Modal) {
            notify(
                'Настройте плагин: Настройки → qBittorrent'
            );
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

        var saveButton = html.querySelector(
            '.qbit-wizard__save'
        );

        var cancelButton = html.querySelector(
            '.qbit-wizard__cancel'
        );

        function close() {
            try {
                Lampa.Modal.close();
            } catch (e) {}
        }

        if (cancelButton) {
            $(cancelButton).on('hover:enter click', function () {
                close();
            });
        }

        if (saveButton) {
            $(saveButton).on('hover:enter click', function () {
                var url = String(
                    html.querySelector('#qbit-wz-url').value || ''
                ).trim();

                var savepath = String(
                    html.querySelector('#qbit-wz-savepath').value || ''
                ).trim();

                var smb = String(
                    html.querySelector('#qbit-wz-smb').value || ''
                ).trim();

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

                if (onDone) onDone();
            });
        }
    }

    function requireSetup(onDone) {
        if (isConfigured()) return true;

        debugNotify('Требуется первая настройка');

        openSetupWizard(onDone);

        return false;
    }

    // ================= HTTP =================

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

        if (request.body) {
            options.body = request.body;
        }

        fetch(request.url, options)
            .then(function (res) {
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }

                return res.text();
            })
            .then(function (text) {
                log(
                    'Fetch response:',
                    String(text).substring(0, 300)
                );

                callback(text);
            })
            .catch(function (error) {
                console.error('[qBittorrent] fetch error:', error);

                callback(null);
            });
    }

    // ================= ANDROIDJS HTTP =================

    function nativeRequest(request, callback) {
        var responded = false;
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
            if (responded) return;

            responded = true;

            callback(normalizeResponse(response));
        }

        function fallback() {
            if (responded) return;

            responded = true;

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
        var maxTries = 150;

        (function poll() {
            if (responded) return;

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

                if (normalized !== null && normalized.length > 0) {
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

    // ================= АВТОРИЗАЦИЯ =================

    function requestBaseHeaders() {
        return {
            'Content-Type':
                'application/x-www-form-urlencoded'
        };
    }

    function authHeaders() {
        var headers = requestBaseHeaders();

        if (sid) {
            headers.Cookie = 'SID=' + sid;
        }

        return headers;
    }

    function doLogin(done) {
        var config = cfg();

        if (config.bypass || !config.user) {
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
                /Forbidden|403|Fails/i.test(response)
            ) {
                notify('Ошибка авторизации qBittorrent');

                done(false);

                return;
            }

            done(true);
        });
    }

    function qbRequest(request, callback) {
        var config = cfg();

        if (config.bypass || !config.user) {
            nativeRequest(request, callback);
            return;
        }

        if (!sid) {
            doLogin(function (ok) {
                if (!ok) {
                    callback(null);
                    return;
                }

                nativeRequest(request, callback);
            });

            return;
        }

        nativeRequest(request, callback);
    }

    // ================= ДОБАВЛЕНИЕ ТОРРЕНТА =================

    function buildAddBody(magnet, title) {
        var config = cfg();

        var body = 'urls=' + encodeURIComponent(magnet);

        var finalSavePath = config.savepath || '';

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
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');

        return body;
    }

    function qbAdd(magnet, title, onComplete) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Не удалось получить magnet-ссылку');
            return;
        }

        var body = buildAddBody(magnet, title);

        debugNotify('Отправляю в qBittorrent...');

        qbRequest({
            url: base() + '/api/v2/torrents/add',
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
                notify('Ошибка добавления торрента');
                return;
            }

            notify('Отправлено в qBittorrent');

            if (onComplete) {
                onComplete();
            }
        });
    }

    // ================= УДАЛЕНИЕ ТОРРЕНТА =================

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

            notify('Торрент удалён');
        });
    }

    // ================= ПРОГРЕСС ЗАГРУЗКИ =================

    function checkTorrentProgress(hash, onProgress) {
        if (!hash) return;

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
                return;
            }

            try {
                var data = JSON.parse(response);

                var torrents = Array.isArray(data) ?
                    data :
                    (data.torrents || []);

                if (torrents.length > 0) {
                    onProgress(
                        Number(torrents[0].progress) || 0
                    );
                }

            } catch (error) {
                console.error(
                    '[qBittorrent] progress parse error:',
                    error
                );
            }
        });
    }

    // ========================================================================
    // SMB — ИСПРАВЛЕННАЯ ОБРАБОТКА ВЛОЖЕННЫХ ПАПОК
    // ========================================================================

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

    function stripLocalRoots(absolutePath, config) {
        var path = String(absolutePath || '')
            .replace(/\\/g, '/');

        var roots = [];

        var savePath = String(config.savepath || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');

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
            if (path.indexOf(roots[i] + '/') === 0) {
                return path.substring(roots[i].length + 1);
            }

            if (path === roots[i]) {
                return '';
            }
        }

        return path.replace(/^\/+/, '');
    }

    // Главная исправленная функция.
    //
    // qBittorrent может создавать:
    //
    // /torrents/Название торрента/film.mkv
    //
    // или:
    //
    // /torrents/Название торрента/BDMV/movie.mkv
    //
    // Имя дополнительной папки сохраняется.
    //
    // Удаляется оно только тогда, когда включён
    // параметр qbit_smb_torrent_folder.

    function makeSmbUri(fileName, torrentName) {
        var config = cfg();

        var smbRoot = String(config.smb_file || '')
            .trim()
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');

        var relative = String(fileName || '')
            .replace(/\\/g, '/');

        // Убираем локальный корень загрузок, если он присутствует.
        relative = stripLocalRoots(relative, config);

        // Убираем имя торрента ТОЛЬКО по настройке.
        if (config.smb_torrent_folder && torrentName) {
            var folder = String(torrentName)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '');

            if (
                folder &&
                relative.indexOf(folder + '/') === 0
            ) {
                relative = relative.substring(
                    folder.length + 1
                );
            }
        }

        var encoded = encodeSmbPath(relative);

        var result = smbRoot +
            (encoded ? '/' + encoded : '');

        log('SMB root:', smbRoot);
        log('Torrent name:', torrentName);
        log('File name:', fileName);
        log('Relative path:', relative);
        log('Final SMB URI:', result);

        return result;
    }

    // ========================================================================
    // ЗАПУСК ВИДЕО В LAMPA
    // ========================================================================

    function openFileInPlayer(fileUri, playerPkg, title) {
        var uri = String(fileUri || '').trim();

        var pkg = String(playerPkg || '').trim();

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
            title: title || 'qBittorrent',
            source: 'qBittorrent',
            quality: 'auto',
            exe: extension
        };

        log('Запуск видео:', playerData);

        // ------------------------------------------------
        // 1. ВСТРОЕННЫЙ ПЛЕЕР LAMPA
        // ------------------------------------------------

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
                '[qBittorrent] Lampa.Player error:',
                error
            );
        }

        // ------------------------------------------------
        // 2. ANDROIDJS OPENPLAYER
        // ------------------------------------------------

        try {
            if (
                window.AndroidJS &&
                typeof window.AndroidJS.openPlayer === 'function'
            ) {
                window.AndroidJS.openPlayer(
                    uri,
                    pkg,
                    title || '',
                    'video/*'
                );

                return;
            }
        } catch (error) {
            console.error(
                '[qBittorrent] AndroidJS error:',
                error
            );
        }

        // ------------------------------------------------
        // 3. ANDROID INTENT
        // ------------------------------------------------

        try {
            if (
                window.AndroidJS &&
                typeof window.AndroidJS.startActivity === 'function'
            ) {
                var intent = {
                    action: 'android.intent.action.VIEW',
                    data: uri,
                    type: 'video/*'
                };

                if (pkg) {
                    intent.package = pkg;
                }

                window.AndroidJS.startActivity(
                    JSON.stringify(intent)
                );

                return;
            }
        } catch (error) {
            console.error(
                '[qBittorrent] startActivity error:',
                error
            );
        }

        notify('Не удалось запустить видеоплеер');
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

            if (Number(torrent.progress) < 1) {
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

                if (
                    !Array.isArray(files) ||
                    !files.length
                ) {
                    notify('В торренте нет файлов');
                    return;
                }

                // Ищем полностью загруженные видео.
                var videoFiles = files.filter(function (file) {
                    return (
                        isVideoFile(file.name) &&
                        Number(file.progress) >= 0.999999
                    );
                });

                if (!videoFiles.length) {
                    notify('Нет полностью скачанных видеофайлов');
                    return;
                }

                // Самое большое видео первым.
                videoFiles.sort(function (a, b) {
                    return Number(b.size) - Number(a.size);
                });

                var selectedFile = videoFiles[0];

                var fileTitle = String(selectedFile.name)
                    .replace(/\\/g, '/')
                    .split('/')
                    .pop();

                var smbUri = makeSmbUri(
                    selectedFile.name,
                    torrent.name
                );

                log('Выбран файл:', selectedFile.name);
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

    // ================= ОБРАБОТКА НАЖАТИЙ =================

    function bindPress(element, handler) {
        var last = 0;

        function wrapped(event) {
            var now = Date.now();

            if (now - last < ACTION_LOCK_MS) {
                return;
            }

            last = now;

            if (event) {
                if (typeof event.preventDefault === 'function') {
                    event.preventDefault();
                }

                if (typeof event.stopPropagation === 'function') {
                    event.stopPropagation();
                }

                if (
                    typeof event.stopImmediatePropagation === 'function'
                ) {
                    event.stopImmediatePropagation();
                }
            }

            handler(event);
        }

        if (window.jQuery) {
            window.jQuery(element).on('hover:enter', wrapped);
            window.jQuery(element).on('click', wrapped);
        } else {
            element.addEventListener('hover:enter', wrapped);
            element.addEventListener('click', wrapped);
        }
    }

    // ================= РЕГИСТРАЦИЯ НАСТРОЕК =================

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
                    ''
                ],

                [
                    'qbit_delete_files',
                    'trigger',
                    false,
                    'Удалять файлы торрента',
                    ''
                ],

                [
                    'qbit_smb_file',
                    'input',
                    '',
                    'Корень SMB-папки загрузок',
                    'Пример: ' + EXAMPLE_SMB_FILE
                ],

                // НОВАЯ НАСТРОЙКА.
                [
                    'qbit_smb_torrent_folder',
                    'trigger',
                    false,
                    'SMB-корень уже содержит папку торрента',
                    'Включайте, если SMB указывает непосредственно на папку торрента'
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

            console.log(
                '[qBittorrent] Настройки зарегистрированы'
            );

        } catch (error) {
            console.error(
                '[qBittorrent] Settings error:',
                error
            );
        }
    }

    // ================= ПУНКТ МЕНЮ =================

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

    // ================= КНОПКИ ТОРРЕНТА =================

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
                    '<path fill="currentColor" d="M8 5v14l11-7z"/>' +
                    '</svg>';

                var deleteIcon =
                    '<svg viewBox="0 0 24 24">' +
                    '<path fill="currentColor" d="' +
                    'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z' +
                    'M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>' +
                    '</svg>';

                // ---------------- ПЛЕЕР ----------------

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

                // ---------------- УДАЛЕНИЕ ----------------

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

                // ---------------- ДОБАВЛЕНИЕ ----------------

                var addButton = createButton(
                    'qbit-direct-add',
                    'qB',
                    function () {
                        if (!requireSetup()) return;

                        if (!magnet) {
                            notify('Не найдена magnet-ссылка');
                            return;
                        }

                        addButton.innerHTML =
                            downloadIcon +
                            '<span class="qbit-btn-text">0%</span>';

                        addButton.classList.add('qbit-loading');

                        qbAdd(magnet, title, function () {
                            if (!hash) {
                                notify(
                                    'Торрент добавлен, но хеш не определён'
                                );

                                return;
                            }

                            var pollTimer = setInterval(function () {
                                try {
                                    if (
                                        !document.body.contains(item)
                                    ) {
                                        clearInterval(pollTimer);
                                        return;
                                    }

                                    checkTorrentProgress(
                                        hash,
                                        function (progress) {
                                            if (progress >= 1) {
                                                clearInterval(pollTimer);

                                                addButton.style.display =
                                                    'none';

                                                notify(
                                                    'Загрузка завершена!'
                                                );

                                            } else {
                                                var span =
                                                    addButton.querySelector(
                                                        '.qbit-btn-text'
                                                    );

                                                if (span) {
                                                    span.textContent =
                                                        Math.floor(
                                                            progress * 100
                                                        ) + '%';
                                                }
                                            }
                                        }
                                    );

                                } catch (error) {
                                    clearInterval(pollTimer);

                                    console.error(
                                        '[qBittorrent] poll error:',
                                        error
                                    );
                                }
                            }, POLL_INTERVAL);
                        });
                    },
                    downloadIcon
                );

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

    // ================= СТИЛИ =================

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

            '.qbit-loading {' +
                'opacity:0.7;' +
                'pointer-events:none;' +
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

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            console.log(
                '[qBittorrent] Инициализация плагина...'
            );

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

            log('Плагин загружен');

        } catch (error) {
            console.error(
                '[qBittorrent] Initialization error:',
                error
            );
        }
    }

    // ================= ЗАПУСК =================

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();

    } else {
        var initialized = false;

        function initOnce() {
            if (initialized) return;

            initialized = true;

            initializePlugin();
        }

        document.addEventListener(
            'appready',
            initOnce
        );

        setTimeout(function () {
            if (window.Lampa && Lampa.Listener) {
                initOnce();
            } else {
                log(
                    'Lampa недоступна после таймаута ожидания'
                );
            }
        }, 5000);
    }

})();
