// ============================================================================
// Плагин qBittorrent для Lampa (Keenetic + Entware + SMB).
// На основе kostya4000/lampa-qbit. Доработан для запуска видео по SMB.
//
// ПЕРЕД ИСПОЛЬЗОВАНИЕМ ИСПРАВЬ ДВА ЗНАЧЕНИЯ НИЖЕ (помечены <<< ИЗМЕНИ).
// ============================================================================

(function () {
    'use strict';

    // Глобальный перехват ошибок — чтобы страница не падала.
    window.addEventListener('error', function (event) {
        try {
            console.error('[qBittorrent] SCRIPT ERROR:', event.message,
                'строка:', event.lineno, event.error);
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show('qBittorrent: ' + event.message +
                    ' (строка ' + event.lineno + ')');
            }
        } catch (e) {}
    });

    window.addEventListener('unhandledrejection', function (event) {
        console.error('[qBittorrent] PROMISE ERROR:', event.reason);
    });

    // ================= ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =================

    var DEF_URL = 'http://192.168.1.1:9080';             // <<< ИЗМЕНИ при необходимости
    var DEF_USER = '';                                   // логин Web UI (если есть)
    var DEF_PASS = '';                                   // пароль Web UI (если есть)
    var DEF_BYPASS = true;                               // true — без авторизации (локальная сеть)
    var DEF_SAVEPATH = '/opt/download/download';         // <<< ИЗМЕНИ: реальный путь загрузок на роутере (см. df -h по SSH)
    var DEF_CATEGORY = '';                               // категория qBittorrent, '' = без категории
    var DEF_RENAME = true;
    var DEF_CONFIRM = true;
    var DEF_AUTO_CAT_PATH = true;
    var DEF_DELETE_FILES = false;
    var DEF_PLAYER_PACKAGE = '';                         // выбери плеер в настройках Lampa
    var DEF_SMB_FILE = 'smb://192.168.1.1/ABOBA/';       // <<< ИЗМЕНИ: имя шары как в Keenetic («Общий доступ»)
    var DEF_ALWAYS_SHOW_BUTTONS = false;

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;

    var nativeRequestId = 0;
    var sid = ''; // сессия qBittorrent

    var CT_FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

    var VIDEO_EXTENSIONS = [
        'mkv', 'mp4', 'avi', 'm4v', 'mov',
        'wmv', 'mpg', 'mpeg', 'ts', 'm2ts',
        'webm', 'flv', 'vob', 'ogv', '3gp'
    ];

    var PLAYERS_LIST = {
        '': 'Не выбран',
        'top.rootu.dddplayer': 'DDD Video Player',
        'org.videolan.vlc': 'VLC',
        'com.mxtech.videoplayer.ad': 'MX Player',
        'net.gtvbox.videoplayer': 'Vimu Player',
        'com.brouken.player': 'Just (Video) Player',
        'org.xbmc.kodi': 'Kodi',
        'com.newin.nplayer.pro': 'nPlayer',
        'com.xplayer.player': 'Xplayer',
        'org.courville.nova': 'Nova Video Player',
        'com.archos.mediacenter.video': 'Archos Video Player',
        'custom': 'Другой (ввести вручную)'
    };

    // ================= УТИЛИТЫ =================

    function log() {
        if (DEBUG) {
            console.log.apply(console, ['[qBittorrent]'].concat(
                Array.prototype.slice.call(arguments)));
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

    function storeGet(key, defaultValue) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var value = Lampa.Storage.get(key, defaultValue);
                if (value !== undefined && value !== null) return value;
            }
        } catch (error) {
            console.error('[qBittorrent] storeGet error:', error);
        }
        return defaultValue;
    }

    function isTrue(value, defaultValue) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return defaultValue;
    }

    function cfg() {
        return {
            url: storeGet('qbit_url', DEF_URL),
            user: storeGet('qbit_user', DEF_USER),
            pass: storeGet('qbit_pass', DEF_PASS),
            bypass: isTrue(storeGet('qbit_bypass', DEF_BYPASS), DEF_BYPASS),
            savepath: storeGet('qbit_savepath', DEF_SAVEPATH),
            category: storeGet('qbit_category', DEF_CATEGORY),
            rename: isTrue(storeGet('qbit_rename', DEF_RENAME), DEF_RENAME),
            confirm: isTrue(storeGet('qbit_confirm', DEF_CONFIRM), DEF_CONFIRM),
            auto_cat_path: isTrue(storeGet('qbit_auto_cat_path', DEF_AUTO_CAT_PATH), DEF_AUTO_CAT_PATH),
            delete_files: isTrue(storeGet('qbit_delete_files', DEF_DELETE_FILES), DEF_DELETE_FILES),
            player_package: storeGet('qbit_player_package', DEF_PLAYER_PACKAGE),
            smb_file: storeGet('qbit_smb_file', DEF_SMB_FILE),
            always_show_buttons: isTrue(storeGet('qbit_always_show_buttons', DEF_ALWAYS_SHOW_BUTTONS), DEF_ALWAYS_SHOW_BUTTONS)
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    function joinPath(a, b) {
        if (!a) return b || '';
        if (!b) return a;
        return String(a).replace(/\/+$/, '') + '/' + String(b).replace(/^\/+/, '');
    }

    function magnetHash(magnet) {
        var value = String(magnet || '');
        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(value);
        if (match) return match[1].toLowerCase();
        value = value.trim();
        if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
        return '';
    }

    function extractMagnet(data) {
        if (!data) return '';
        if (typeof data === 'string') {
            return /^magnet:\?/i.test(data) ? data : '';
        }
        if (typeof data !== 'object') return '';

        var fields = ['MagnetUri', 'magnetUri', 'magnet_uri',
            'magnet', 'Magnet', 'url', 'torrent_url', 'torrentUrl', 'link'];

        for (var i = 0; i < fields.length; i++) {
            if (typeof data[fields[i]] === 'string' &&
                /^magnet:\?/i.test(data[fields[i]])) {
                return data[fields[i]];
            }
        }
        return '';
    }

    function extractTorrentHash(data, depth) {
        depth = depth || 0;
        if (!data || depth > 4) return '';
        if (typeof data === 'string') return magnetHash(data);
        if (typeof data !== 'object') return '';

        var direct = ['hash', 'Hash', 'infohash', 'infoHash', 'InfoHash',
            'infohash_v1', 'infoHashV1', 'btih'];

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

        var nested = ['torrent', 'item', 'data', 'element', 'source', 'model', 'card'];
        for (var j = 0; j < nested.length; j++) {
            if (data[nested[j]]) {
                var n = extractTorrentHash(data[nested[j]], depth + 1);
                if (n) return n;
            }
        }
        return '';
    }

    function isVideoFile(filename) {
        var match = /\.([^.\/\\]+)$/.exec(String(filename || '').toLowerCase());
        return match ? VIDEO_EXTENSIONS.indexOf(match[1]) !== -1 : false;
    }

    function formatSize(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1024).toFixed(1) + ' KB';
    }

    // ================= HTTP ЗАПРОСЫ =================

    function normalizeResponse(response) {
        if (response === null || response === undefined) return null;
        if (typeof response === 'string') return response;
        if (typeof response === 'object') {
            if (typeof response.responseText === 'string') return response.responseText;
            if (typeof response.response === 'string') return response.response;
            if (typeof response.body === 'string') return response.body;
            if (typeof response.data === 'string') return response.data;
            try { return JSON.stringify(response); } catch (error) { return null; }
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
        if (request.body) options.body = request.body;

        fetch(request.url, options)
            .then(function (res) { return res.text(); })
            .then(function (text) {
                log('Fetch response:', String(text).substring(0, 300));
                callback(text);
            })
            .catch(function (error) {
                console.error('[qBittorrent] fetch error:', error);
                callback(null);
            });
    }

    // AndroidJS bridge:
    // AndroidJS.httpReq(JSON.stringify({url, timeout, headers, post_data}), requestId)
    // AndroidJS.getResp(String(requestId))
    function nativeRequest(request, callback) {
        var responded = false;
        var requestId = ++nativeRequestId;

        var payload = {
            url: request.url,
            timeout: 20000,
            headers: request.headers || {}
        };
        if (request.body !== undefined && request.body !== null && request.body !== '') {
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
            log('AndroidJS не ответил, переключаюсь на fetch.');
            fetchRequest(request, callback);
        }

        if (!window.AndroidJS ||
            typeof window.AndroidJS.httpReq !== 'function' ||
            typeof window.AndroidJS.getResp !== 'function') {
            log('AndroidJS HTTP недоступен, использую fetch.');
            fetchRequest(request, callback);
            return;
        }

        try {
            log('Native HTTP:', request.method || 'GET', payload.url, 'ID:', requestId);
            window.AndroidJS.httpReq(JSON.stringify(payload), requestId);
        } catch (error) {
            console.error('[qBittorrent] AndroidJS httpReq error:', error);
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
                response = window.AndroidJS.getResp(String(requestId));
            } catch (error) {
                console.error('[qBittorrent] AndroidJS getResp error:', error);
            }

            if (response !== null && response !== undefined) {
                var normalized = normalizeResponse(response);
                if (normalized !== null && normalized.length > 0) {
                    log('Native response:', normalized.substring(0, 300));
                    finish(normalized);
                    return;
                }
            }

            if (tries >= maxTries) {
                log('Таймаут AndroidJS, ID:', requestId);
                fallback();
                return;
            }
            setTimeout(poll, 150);
        })();
    }

    // ================= АВТОРИЗАЦИЯ И ЗАПРОСЫ =================

    function authHeaders() {
        var headers = requestBaseHeaders();
        if (sid) headers.Cookie = 'SID=' + sid;
        return headers;
    }

    function requestBaseHeaders() {
        return { 'Content-Type': 'application/x-www-form-urlencoded' };
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
            body: 'username=' + encodeURIComponent(config.user) +
                '&password=' + encodeURIComponent(config.pass),
            headers: CT_FORM
        }, function (response) {
            // При успехе qBittorrent возвращает "Ok." и ставит куку SID.
            if (!response || /Forbidden|403|Fails/i.test(response)) {
                console.error('[qBittorrent] Authentication failed');
                notify('Ошибка авторизации qBittorrent');
                done(false);
                return;
            }

            // Пытаемся вытащить SID из ответа (если мост отдал заголовки).
            try {
                var obj = typeof response === 'string' ? null : response;
                if (obj && obj.headers) {
                    var cookieLine = obj.headers['set-cookie'] || obj.headers['Set-Cookie'] || '';
                    var m = /SID=([a-zA-Z0-9]+)/.exec(String(cookieLine));
                    if (m) sid = m[1];
                }
            } catch (e) {}

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
                if (!ok) { callback(null); return; }
                nativeRequest(request, callback);
            });
            return;
        }

        nativeRequest(request, callback);
    }

    // ================= QBITTORRENT =================

    function buildAddBody(magnet, title) {
        var config = cfg();
        var body = 'urls=' + encodeURIComponent(magnet);
        var finalSavePath = config.savepath || '';
        var autoTMM = false;

        if (config.auto_cat_path && config.category) {
            if (finalSavePath) {
                finalSavePath = joinPath(finalSavePath, config.category);
            } else {
                autoTMM = true;
            }
        }

        if (finalSavePath) {
            body += '&savepath=' + encodeURIComponent(finalSavePath);
        }
        if (config.category) {
            body += '&category=' + encodeURIComponent(config.category);
        }
        if (config.rename && title) {
            body += '&rename=' + encodeURIComponent(title);
        }

        body += '&paused=false&stopped=false';
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');
        body += '&useAutoTMM=' + (autoTMM ? 'true' : 'false');

        return body;
    }

    function qbAdd(magnet, title, onComplete) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            console.warn('[qBittorrent] Invalid magnet:', magnet);
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
            if (response === null || response === undefined) {
                notify('Нет связи с qBittorrent');
                return;
            }

            if (/Forbidden|403|Fails/i.test(response)) {
                notify('Ошибка добавления торрента');
                return;
            }

            notify('Отправлено в qBittorrent');
            if (onComplete) onComplete();
        });
    }

    function qbDelete(hashOrMagnet) {
        // Принимаем и magnet, и готовый хеш — отправляем всегда чистый хеш.
        var hash = magnetHash(hashOrMagnet);

        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        var body = 'hashes=' + encodeURIComponent(hash) +
            '&deleteFiles=' + (cfg().delete_files ? 'true' : 'false');

        debugNotify('Удаляю торрент...');

        qbRequest({
            url: base() + '/api/v2/torrents/delete',
            method: 'POST',
            body: body,
            headers: authHeaders()
        }, function (response) {
            if (response === null || response === undefined) {
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

    function checkTorrentProgress(hash, onProgress) {
        if (!hash) return;

        qbRequest({
            url: base() + '/api/v2/torrents/info?hashes=' + encodeURIComponent(hash),
            method: 'GET',
            headers: authHeaders()
        }, function (response) {
            if (typeof response !== 'string' || !response.length) return;

            try {
                var data = JSON.parse(response);
                var torrents = Array.isArray(data) ? data : (data.torrents || []);

                if (torrents.length > 0) {
                    onProgress(Number(torrents[0].progress) || 0);
                }
            } catch (error) {
                console.error('[qBittorrent] progress parse error:', error);
            }
        });
    }

    // ================= SMB: ПРЕОБРАЗОВАНИЕ ПУТИ =================

    function encodeSmbPath(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(function (part) { return part !== ''; })
            .map(function (part) { return encodeURIComponent(part); })
            .join('/');
    }

    // Убираем локальные корни из абсолютного пути файла.
    function stripLocalRoots(absolutePath, config) {
        var path = String(absolutePath || '').replace(/\\/g, '/');

        var roots = [];

        var savePath = String(config.savepath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (savePath) {
            roots.push(savePath);
            if (config.category) {
                roots.push(joinPath(savePath, config.category));
            }
        }

        // Перебираем корни от самого длинного к короткому.
        roots.sort(function (a, b) { return b.length - a.length; });

        for (var i = 0; i < roots.length; i++) {
            if (path.indexOf(roots[i] + '/') === 0) {
                return path.substring(roots[i].length + 1);
            }
            if (path === roots[i]) return '';
        }

        return path;
    }

    // Если пришёл относительный путь торрента ("Name/file.mkv"),
    // отрезаем первый сегмент, если он совпадает с именем торрента в пути SMB-корня.
    function makeSmbUri(fileName, torrentName) {
        var config = cfg();

        var smbRoot = String(config.smb_file || DEF_SMB_FILE)
            .trim()
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');

        var relative = String(fileName || '').replace(/\\/g, '/');

        // 1) Пробуем отрезать абсолютные корни (savepath, savepath/категория).
        var stripped = stripLocalRoots(relative, config);

        // 2) Если после этого остался ведущий сегмент = имя торрента и
        //    SMB-корень уже указывает на папку торрента — отрезаем его.
        if (torrentName) {
            var torrentNameNorm = String(torrentName).replace(/\\/g, '/').replace(/\/+$/, '');
            if (torrentNameNorm &&
                stripped.indexOf(torrentNameNorm + '/') === 0) {
                stripped = stripped.substring(torrentNameNorm.length + 1);
            }
        }

        var result = smbRoot + '/' + encodeSmbPath(stripped);

        log('SMB root:', smbRoot);
        log('Relative path:', stripped);
        log('SMB URI:', result);

        return result;
    }

    // ================= ОТКРЫТИЕ ФАЙЛА В ПЛЕЕРЕ =================

    function openFileInPlayer(fileUri, playerPkg, title) {
        var uri = String(fileUri || '').trim();
        var pkg = String(playerPkg || '').trim();

        if (!uri) {
            notify('Не указан путь к видеофайлу');
            return;
        }
        if (!pkg || pkg === 'custom') {
            notify('Выберите видеоплеер в настройках');
            return;
        }

        debugNotify('Открываю: ' + (title || uri));
        log('Запуск плеера:', pkg, uri);

        // 1. Lampa Android bridge.
        try {
            if (window.Lampa && Lampa.Android &&
                typeof Lampa.Android.openPlayer === 'function') {
                Lampa.Android.openPlayer(uri, { package: pkg, title: title || '' });
                return;
            }
        } catch (error) {
            console.error('[qBittorrent] Lampa.Android error:', error);
        }

        // 2. Прямой вызов AndroidJS.
        try {
            if (window.AndroidJS && typeof window.AndroidJS.openPlayer === 'function') {
                window.AndroidJS.openPlayer(uri, pkg, title || '', 'video/*');
                return;
            }
        } catch (error) {
            console.error('[qBittorrent] AndroidJS error:', error);
        }

        // 3. Intent через AndroidJS.
        try {
            if (window.AndroidJS && typeof window.AndroidJS.startActivity === 'function') {
                window.AndroidJS.startActivity(JSON.stringify({
                    action: 'android.intent.action.VIEW',
                    data: uri,
                    type: 'video/*',
                    package: pkg
                }));
                return;
            }
        } catch (error) {
            console.error('[qBittorrent] startActivity error:', error);
        }

        notify('Не удалось запустить видеоплеер');
    }

    // ================= ФАЙЛЫ ТОРРЕНТА И КНОПКА ПЛЕЕРА =================

    function handlePlayerButton(hash) {
        var config = cfg();

        if (!config.player_package || config.player_package === 'custom') {
            notify('Сначала выберите видеоплеер в настройках');
            return;
        }
        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        log('Выбран хеш торрента:', hash);
        debugNotify('Получаю информацию о торренте...');

        qbRequest({
            url: base() + '/api/v2/torrents/info?hashes=' + encodeURIComponent(hash),
            method: 'GET',
            headers: authHeaders()
        }, function (infoResponse) {

            log('Ответ torrents/info:', infoResponse);

            if (!infoResponse) {
                notify('Не удалось получить информацию о торренте');
                return;
            }

            var torrent;
            try {
                var info = JSON.parse(infoResponse);
                var torrents = Array.isArray(info) ? info : (info.torrents || []);
                if (!torrents.length) {
                    notify('Торрент не найден в qBittorrent');
                    return;
                }
                torrent = torrents[0];
            } catch (error) {
                console.error('[qBittorrent] info parse error:', error);
                notify('Ошибка чтения информации о торренте');
                return;
            }

            if (Number(torrent.progress) < 1) {
                notify('Торрент ещё не загружен полностью');
                return;
            }

            debugNotify('Получаю список файлов...');

            qbRequest({
                url: base() + '/api/v2/torrents/files?hash=' + encodeURIComponent(hash),
                method: 'GET',
                headers: authHeaders()
            }, function (filesResponse) {

                log('Ответ torrents/files:', filesResponse);

                if (!filesResponse) {
                    notify('Не удалось получить список файлов');
                    return;
                }

                var files;
                try {
                    files = JSON.parse(filesResponse);
                } catch (error) {
                    console.error('[qBittorrent] files parse error:', error);
                    notify('Ошибка чтения списка файлов');
                    return;
                }

                if (!Array.isArray(files) || !files.length) {
                    notify('В торренте нет файлов');
                    return;
                }

                // Только полностью скачанные видео.
                var videoFiles = files.filter(function (file) {
                    return isVideoFile(file.name) &&
                        Number(file.progress) >= 0.999999;
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

                var smbUri = makeSmbUri(selectedFile.name, torrent.name);

                log('Выбран видеофайл:', selectedFile.name);
                log('Размер:', formatSize(selectedFile.size));
                log('SMB URI:', smbUri);

                notify('Запускаю: ' + fileTitle);
                openFileInPlayer(smbUri, config.player_package, fileTitle);
            });
        });
    }

    // ================= НАЖАТИЯ =================

    function bindPress(element, handler) {
        var last = 0;

        function wrapped(event) {
            var now = Date.now();
            if (now - last < ACTION_LOCK_MS) return;
            last = now;

            if (event) {
                event.preventDefault();
                event.stopPropagation();
                if (event.stopImmediatePropagation) {
                    event.stopImmediatePropagation();
                }
            }
            handler(event);
        }

        element.addEventListener('hover:enter', wrapped);
        element.addEventListener('click', wrapped);
    }

    // ================= НАСТРОЙКИ =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) {
                console.error('[qBittorrent] SettingsApi unavailable');
                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            var params = [
                ['qbit_url', 'input', DEF_URL, 'Адрес сервера', 'http://192.168.1.1:9080'],
                ['qbit_user', 'input', DEF_USER, 'Логин', 'Логин Web UI'],
                ['qbit_pass', 'input', DEF_PASS, 'Пароль', 'Пароль Web UI'],
                ['qbit_bypass', 'trigger', DEF_BYPASS, 'Обход аутентификации', 'Для локальной сети'],
                ['qbit_savepath', 'input', DEF_SAVEPATH, 'Путь загрузки qBittorrent', '/путь/к/загрузкам'],
                ['qbit_category', 'input', DEF_CATEGORY, 'Категория', 'Например: video'],
                ['qbit_auto_cat_path', 'trigger', DEF_AUTO_CAT_PATH, 'Добавлять категорию к пути', ''],
                ['qbit_rename', 'trigger', DEF_RENAME, 'Переименовывать торрент', ''],
                ['qbit_confirm', 'trigger', DEF_CONFIRM, 'Проверять добавление', ''],
                ['qbit_delete_files', 'trigger', DEF_DELETE_FILES, 'Удалять файлы торрента', ''],
                ['qbit_always_show_buttons', 'trigger', DEF_ALWAYS_SHOW_BUTTONS, 'Всегда показывать Плеер и Удалить', 'Не скрывать кнопки'],
                ['qbit_smb_file', 'input', DEF_SMB_FILE, 'Корень SMB-папки загрузок', 'smb://адрес/шара/']
            ];

            params.forEach(function (item) {
                Lampa.SettingsApi.addParam({
                    component: 'qbit_direct',
                    param: { name: item[0], type: item[1], values: '', default: item[2] },
                    field: { name: item[3], description: item[4] }
                });
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_player_package', type: 'select', values: PLAYERS_LIST, default: DEF_PLAYER_PACKAGE },
                field: { name: 'Видеоплеер', description: 'Выберите установленный плеер' }
            });

            console.log('[qBittorrent] Настройки зарегистрированы');
        } catch (error) {
            console.error('[qBittorrent] Settings error:', error);
        }
    }

    // ================= ПУНКТ МЕНЮ =================

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu ||
                typeof Lampa.Menu.addButton !== 'function') {
                return;
            }

            var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_direct"]');
                    if (item) item.click();
                }, 100);
            });
        } catch (error) {
            console.error('[qBittorrent] Menu error:', error);
        }
    }

    // ================= КНОПКИ В КАРТОЧКЕ =================

    function createButton(className, text, handler, iconSvg) {
        var button = document.createElement('div');
        button.className = 'qbit-direct-btn ' + className + ' selector';
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
            console.error('[qBittorrent] Listener unavailable');
            return;
        }

        Lampa.Listener.follow('torrent', function (event) {
            try {
                if (!event || event.type !== 'render' || !event.item) return;

                var item = event.item.jquery ? event.item[0] : event.item;
                if (!item) return;

                var data = event.element || {};

                var container = item.querySelector('.torrent-item__right') ||
                    item.querySelector('.torrent-item') || item;

                if (container.querySelector('.qbit-direct-actions')) return;

                var magnet = extractMagnet(data) || extractMagnet(event);
                var hash = extractTorrentHash(data) || extractTorrentHash(event);

                if (!hash && magnet) hash = magnetHash(magnet);

                var title = data.Title || data.title || data.name || data.Name || '';

                log('torrent render:', event.type);
                log('magnet:', magnet);
                log('hash:', hash);

                var config = cfg();
                var alwaysShow = config.always_show_buttons;

                var actions = document.createElement('div');
                actions.className = 'qbit-direct-actions';

                var downloadIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
                var playIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
                var deleteIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

                var playerButton = createButton('qbit-direct-player', '', function () {
                    var currentHash = hash ||
                        extractTorrentHash(data) ||
                        extractTorrentHash(event) ||
                        magnetHash(magnet);
                    log('Нажата Плеер. Хеш:', currentHash);
                    handlePlayerButton(currentHash);
                }, playIcon);

                var deleteButton = createButton('qbit-direct-delete', '', function () {
                    var target = hash || magnet;
                    qbDelete(target);
                }, deleteIcon);

                var addButton = createButton('qbit-direct-add', 'qB', function () {
                    if (!magnet) {
                        notify('Не найдена magnet-ссылка');
                        return;
                    }

                    if (alwaysShow) {
                        qbAdd(magnet, title);
                        return;
                    }

                    addButton.innerHTML = downloadIcon +
                        '<span class="qbit-btn-text">0%</span>';
                    addButton.classList.add('qbit-loading');

                    qbAdd(magnet, title, function () {
                        if (!hash) {
                            notify('Торрент добавлен, но не удалось получить хеш');
                            return;
                        }

                        var pollTimer = setInterval(function () {
                            try {
                                if (!document.body.contains(item)) {
                                    clearInterval(pollTimer);
                                    return;
                                }

                                checkTorrentProgress(hash, function (progress) {
                                    if (progress >= 1) {
                                        clearInterval(pollTimer);
                                        addButton.style.display = 'none';
                                        playerButton.style.display = 'flex';
                                        deleteButton.style.display = 'flex';
                                        notify('Загрузка завершена!');
                                    } else {
                                        var span = addButton.querySelector('.qbit-btn-text');
                                        if (span) {
                                            span.textContent = Math.floor(progress * 100) + '%';
                                        }
                                    }
                                });
                            } catch (error) {
                                clearInterval(pollTimer);
                                console.error('[qBittorrent] poll error:', error);
                            }
                        }, POLL_INTERVAL);
                    });
                }, downloadIcon);

                if (!alwaysShow) {
                    playerButton.style.display = 'none';
                    deleteButton.style.display = 'none';
                }

                actions.appendChild(addButton);
                actions.appendChild(playerButton);
                actions.appendChild(deleteButton);

                container.appendChild(actions);
            } catch (error) {
                console.error('[qBittorrent] render handler error:', error);
            }
        });
    }

    // ================= СТИЛИ =================

    function addStyles() {
        if (document.getElementById('qbit-direct-style')) return;

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

            '.qbit-direct-player svg { fill:#3498db; }' +
            '.qbit-direct-delete svg { fill:#e74c3c; }' +

            '.qbit-loading {' +
                'opacity:0.7;' +
                'pointer-events:none;' +
            '}';

        document.head.appendChild(style);
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            console.log('[qBittorrent] Инициализация плагина...');

            registerSettings();
            addMenuItem();
            initTorrentButton();
            addStyles();

            log('Адрес сервера:', base());
            log('Путь загрузки:', cfg().savepath);
            log('SMB:', cfg().smb_file);
            log('Плагин загружен');
        } catch (error) {
            console.error('[qBittorrent] Initialization error:', error);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        // Если событие appready уже прошло или не наступит — инициализируемся по таймауту.
        var initialized = false;

        function initOnce() {
            if (initialized) return;
            initialized = true;
            initializePlugin();
        }

        document.addEventListener('appready', initOnce);

        setTimeout(function () {
            if (window.Lampa && Lampa.Listener) initOnce();
            else log('Lampa недоступна после таймаута ожидания.');
        }, 5000);
    }

})();
