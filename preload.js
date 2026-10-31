
// ============================================================================
// Плагин qBittorrent для Lampa.
// На основе плагина kostya4000/lampa-qbit
// Доработка: запуск скачанных видео через SMB на Android TV.
// ============================================================================

(function () {
    'use strict';

    // ================= ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =================

    var DEF_URL = 'http://192.168.1.1:9080';
    var DEF_USER = '';
    var DEF_PASS = '';
    var DEF_BYPASS = true;
    var DEF_SAVEPATH = '/opt/download/download';
    var DEF_CATEGORY = '';
    var DEF_RENAME = true;
    var DEF_CONFIRM = true;
    var DEF_AUTO_CAT_PATH = true;
    var DEF_DELETE_FILES = false;
    var DEF_PLAYER_PACKAGE = '';
    var DEF_SMB_FILE = 'smb://192.168.1.1/ABOBA/';
    var DEF_ALWAYS_SHOW_BUTTONS = false;

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

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
                Array.prototype.slice.call(arguments)
            ));
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

                if (value !== undefined && value !== null) {
                    return value;
                }
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

    function joinPath(basePath, subPath) {
        if (!basePath) return subPath || '';
        if (!subPath) return basePath;

        return String(basePath).replace(/\/+$/, '') +
            '/' + String(subPath).replace(/^\/+/, '');
    }

    function magnetHash(magnet) {
        var value = String(magnet || '');

        // Обычный magnet URI.
        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(value);

        if (match) return match[1].toLowerCase();

        // Если передан непосредственно хеш.
        value = value.trim();

        if (/^[a-f0-9]{40}$/i.test(value)) {
            return value.toLowerCase();
        }

        return '';
    }

    // Получение magnet URI из разных вариантов структуры Lampa.
    function extractMagnet(data) {
        if (!data) return '';

        if (typeof data === 'string') {
            return /^magnet:\?/i.test(data) ? data : '';
        }

        var fields = [
            'MagnetUri',
            'magnetUri',
            'magnet_uri',
            'magnet',
            'Magnet',
            'url'
        ];

        for (var i = 0; i < fields.length; i++) {
            if (typeof data[fields[i]] === 'string' &&
                /^magnet:\?/i.test(data[fields[i]])) {
                return data[fields[i]];
            }
        }

        return '';
    }

    // Более надёжное получение хеша из объекта торрента.
    function extractTorrentHash(data, depth) {
        depth = depth || 0;

        if (!data || depth > 4) return '';

        if (typeof data === 'string') {
            return magnetHash(data);
        }

        if (typeof data !== 'object') return '';

        var directFields = [
            'hash',
            'Hash',
            'infohash',
            'infoHash',
            'InfoHash',
            'infohash_v1',
            'infoHashV1',
            'btih'
        ];

        for (var i = 0; i < directFields.length; i++) {
            if (data[directFields[i]]) {
                var direct = magnetHash(data[directFields[i]]);

                if (direct) return direct;
            }
        }

        var magnet = extractMagnet(data);

        if (magnet) {
            var magnetResult = magnetHash(magnet);

            if (magnetResult) return magnetResult;
        }

        var nestedFields = [
            'torrent',
            'item',
            'data',
            'element',
            'source',
            'model',
            'card'
        ];

        for (var j = 0; j < nestedFields.length; j++) {
            if (data[nestedFields[j]]) {
                var nested = extractTorrentHash(
                    data[nestedFields[j]],
                    depth + 1
                );

                if (nested) return nested;
            }
        }

        return '';
    }

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

    // ================= HTTP ЗАПРОСЫ =================

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

    function nativeRequest(request, callback) {
        var responded = false;

        function finish(response) {
            if (responded) return;

            var normalized = normalizeResponse(response);

            // Пустой ответ считаем неудачным и пробуем fetch.
            if (normalized === null || normalized.length === 0) {
                if (!responded) {
                    responded = true;

                    log('AndroidJS не вернул ответ. Пробую fetch.');

                    fetchRequest(request, callback);
                }

                return;
            }

            responded = true;
            callback(normalized);
        }

        if (!window.AndroidJS ||
            typeof AndroidJS.httpReq !== 'function') {

            log('AndroidJS.httpReq недоступен. Использую fetch.');
            fetchRequest(request, callback);
            return;
        }

        try {
            // Очищаем старый ответ.
            AndroidJS.getResp();
        } catch (error) {}

        try {
            log('HTTP:', request.method || 'GET', request.url);

            AndroidJS.httpReq(JSON.stringify(request));

        } catch (e) {
            try {
                AndroidJS.httpReq(
                    request.url,
                    JSON.stringify({
                        method: request.method || 'GET',
                        body: request.body || '',
                        headers: request.headers || {}
                    })
                );
            } catch (e2) {
                log('Ошибка AndroidJS.httpReq:', e2);
                fetchRequest(request, callback);
                return;
            }
        }

        var tries = 0;
        var maxTries = 30;

        (function poll() {
            if (responded) return;

            tries++;

            var response = null;

            try {
                response = AndroidJS.getResp();
            } catch (error) {}

            var normalized = normalizeResponse(response);

            if (normalized !== null && normalized.length > 0) {
                finish(normalized);
                return;
            }

            if (tries >= maxTries) {
                if (!responded) {
                    responded = true;

                    log('Таймаут AndroidJS. Пробую fetch.');

                    fetchRequest(request, callback);
                }

                return;
            }

            setTimeout(poll, 150);
        })();
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
                return res.text();
            })
            .then(function (text) {
                log('Fetch response:', text.substring(0, 300));
                callback(text);
            })
            .catch(function (error) {
                console.error('[qBittorrent] fetch error:', error);
                callback(null);
            });
    }

    // ================= АВТОРИЗАЦИЯ И ЗАПРОСЫ =================

    function qbRequest(request, callback) {
        var config = cfg();

        if (config.bypass || !config.user) {
            nativeRequest(request, callback);
            return;
        }

        nativeRequest({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body: 'username=' + encodeURIComponent(config.user) +
                '&password=' + encodeURIComponent(config.pass),
            headers: CT_FORM
        }, function (response) {
            if (response === null ||
                /Forbidden|403|Fails/i.test(response)) {

                console.error('[qBittorrent] Authentication failed');
                notify('Ошибка авторизации qBittorrent');
                callback(null);
                return;
            }

            nativeRequest(request, callback);
        });
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

        return body;
    }

    function qbAdd(magnet, title, onComplete) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            console.warn('[qBittorrent] Invalid magnet');
            notify('Не удалось получить magnet-ссылку');
            return;
        }

        var body = buildAddBody(magnet, title);

        debugNotify('Отправляю в qBittorrent...');

        qbRequest({
            url: base() + '/api/v2/torrents/add',
            method: 'POST',
            body: body,
            headers: CT_FORM
        }, function (response) {
            if (response === null) return;

            if (/Forbidden|403|Fails/i.test(response)) {
                notify('Ошибка добавления торрента');
                return;
            }

            notify('Отправлено в qBittorrent');

            if (onComplete) onComplete();
        });
    }

    function qbDelete(magnet) {
        var hash = magnetHash(magnet);

        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return;
        }

        var config = cfg();

        var body = 'hashes=' + encodeURIComponent(hash) +
            '&deleteFiles=' + (config.delete_files ? 'true' : 'false');

        debugNotify('Удаляю торрент...');

        qbRequest({
            url: base() + '/api/v2/torrents/delete',
            method: 'POST',
            body: body,
            headers: CT_FORM
        }, function (response) {
            if (response === null) return;

            if (/Forbidden|403/i.test(response)) {
                notify('Ошибка удаления торрента');
                return;
            }

            notify('Торрент удалён');
        });
    }

    function checkTorrentProgress(hash, onProgress) {
        if (!hash) return;

        qbRequest({
            url: base() + '/api/v2/torrents/info?hashes=' +
                encodeURIComponent(hash),
            method: 'GET'
        }, function (response) {
            if (typeof response !== 'string' || !response.length) return;

            try {
                var data = JSON.parse(response);
                var torrents = data.torrents || data;

                if (Array.isArray(torrents) && torrents.length > 0) {
                    onProgress(Number(torrents[0].progress));
                }
            } catch (error) {
                console.error('[qBittorrent] progress error:', error);
            }
        });
    }

    // ================= SMB: ПРЕОБРАЗОВАНИЕ ПУТИ =================

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

    function makeSmbUri(fileName) {
        var config = cfg();

        var smbRoot = String(config.smb_file || DEF_SMB_FILE)
            .trim()
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');

        var relativePath = String(fileName || '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '');

        var savePath = String(config.savepath || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');

        // Если qBittorrent вернул абсолютный путь,
        // удаляем локальную часть пути загрузки.
        if (savePath &&
            relativePath.indexOf(savePath + '/') === 0) {

            relativePath = relativePath.substring(savePath.length + 1);
        }

        // В данном случае SMB-корень уже соответствует
        // /opt/download/download, поэтому имя каталога
        // download повторно добавлять не нужно.

        var result = smbRoot + '/' + encodeSmbPath(relativePath);

        log('SMB root:', smbRoot);
        log('Relative path:', relativePath);
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

        debugNotify('Открываю видео: ' + title);

        log('Запуск плеера:', pkg);
        log('URI:', uri);

        try {
            if (window.Lampa &&
                Lampa.Android &&
                typeof Lampa.Android.openPlayer === 'function') {

                Lampa.Android.openPlayer(uri, {
                    package: pkg,
                    title: title || ''
                });

                return;
            }
        } catch (e) {
            console.error('[qBittorrent] Lampa.Android error:', e);
        }

        try {
            if (window.AndroidJS &&
                typeof AndroidJS.openPlayer === 'function') {

                AndroidJS.openPlayer(uri, pkg, title || '', 'video/*');
                return;
            }
        } catch (e) {
            console.error('[qBittorrent] AndroidJS error:', e);
        }

        try {
            if (window.AndroidJS &&
                typeof AndroidJS.startActivity === 'function') {

                AndroidJS.startActivity(JSON.stringify({
                    action: 'android.intent.action.VIEW',
                    data: uri,
                    type: 'video/*',
                    package: pkg
                }));

                return;
            }
        } catch (e) {
            console.error('[qBittorrent] startActivity error:', e);
        }

        try {
            if (window.Android &&
                typeof Android.openPlayer === 'function') {

                Android.openPlayer(uri, {
                    package: pkg,
                    title: title || ''
                });

                return;
            }
        } catch (e) {
            console.error('[qBittorrent] Android error:', e);
        }

        notify('Не удалось запустить видеоплеер');
    }

    // ================= ПОЛУЧЕНИЕ ФАЙЛОВ ТОРРЕНТА =================

    function handlePlayerButton(hash) {
        var config = cfg();

        if (!config.player_package ||
            config.player_package === 'custom') {

            notify('Сначала выберите видеоплеер в настройках');
            return;
        }

        if (!hash) {
            notify('Не удалось определить хеш торрента');
            log('Пустой хеш при нажатии кнопки Плеер');
            return;
        }

        log('Выбран хеш торрента:', hash);

        debugNotify('Получаю информацию о торренте...');

        qbRequest({
            url: base() + '/api/v2/torrents/info?hashes=' +
                encodeURIComponent(hash),
            method: 'GET'
        }, function (infoResponse) {

            log('Ответ torrents/info:', infoResponse);

            if (!infoResponse) {
                notify('Не удалось получить информацию о торренте');
                return;
            }

            var torrent;

            try {
                var info = JSON.parse(infoResponse);
                var torrents = info.torrents || info;

                if (!Array.isArray(torrents) || !torrents.length) {
                    notify('Торрент не найден в qBittorrent');
                    log('Пустой список торрентов:', info);
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

            log('Торрент загружен:', torrent.name);

            debugNotify('Получаю список файлов...');

            qbRequest({
                url: base() + '/api/v2/torrents/files?hash=' +
                    encodeURIComponent(hash),
                method: 'GET'
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

                // Выбираем только полностью загруженные видео.
                var videoFiles = files.filter(function (file) {
                    return isVideoFile(file.name) &&
                        Number(file.progress) >= 0.999999;
                });

                if (!videoFiles.length) {
                    notify('Нет полностью скачанных видеофайлов');
                    return;
                }

                // Сначала самое большое видео.
                videoFiles.sort(function (a, b) {
                    return Number(b.size) - Number(a.size);
                });

                var selectedFile = videoFiles[0];

                var fileTitle = String(selectedFile.name)
                    .replace(/\\/g, '/')
                    .split('/')
                    .pop();

                var smbUri = makeSmbUri(selectedFile.name);

                log('Выбран видеофайл:', selectedFile.name);
                log('Размер:', formatSize(selectedFile.size));
                log('SMB URI:', smbUri);

                notify('Запускаю: ' + fileTitle);

                openFileInPlayer(
                    smbUri,
                    config.player_package,
                    fileTitle
                );
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
                ['qbit_savepath', 'input', DEF_SAVEPATH, 'Путь загрузки qBittorrent', '/opt/download/download'],
                ['qbit_category', 'input', DEF_CATEGORY, 'Категория', 'Например: video'],
                ['qbit_auto_cat_path', 'trigger', DEF_AUTO_CAT_PATH, 'Добавлять категорию к пути', ''],
                ['qbit_rename', 'trigger', DEF_RENAME, 'Переименовывать торрент', ''],
                ['qbit_confirm', 'trigger', DEF_CONFIRM, 'Проверять добавление', ''],
                ['qbit_delete_files', 'trigger', DEF_DELETE_FILES, 'Удалять файлы торрента', ''],
                ['qbit_always_show_buttons', 'trigger', DEF_ALWAYS_SHOW_BUTTONS, 'Всегда показывать Плеер и Удалить', 'Не скрывать кнопки'],
                ['qbit_smb_file', 'input', DEF_SMB_FILE, 'Корень SMB-папки загрузок', 'smb://192.168.1.1/ABOBA/']
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

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_player_package',
                    type: 'select',
                    values: PLAYERS_LIST,
                    default: DEF_PLAYER_PACKAGE
                },
                field: {
                    name: 'Видеоплеер',
                    description: 'Выберите установленный плеер'
                }
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
                    var item = document.querySelector(
                        '[data-component="qbit_direct"]'
                    );

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
            var textSpan = document.createElement('span');
            textSpan.textContent = text;
            textSpan.className = 'qbit-btn-text';
            button.appendChild(textSpan);
        }

        bindPress(button, handler);

        return button;
    }

    // ================= ИНИЦИАЛИЗАЦИЯ КНОПОК =================

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) {
            console.error('[qBittorrent] Listener unavailable');
            return;
        }

        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render' || !event.item) return;

            var item = event.item.jquery ? event.item[0] : event.item;
            var data = event.element || {};

            if (!item) return;

            var container = item.querySelector('.torrent-item__right') ||
                item.querySelector('.torrent-item') || item;

            if (container.querySelector('.qbit-direct-actions')) return;

            // Получаем magnet и хеш из разных возможных полей.
            var magnet = extractMagnet(data);

            if (!magnet) {
                magnet = extractMagnet(event);
            }

            var hash = extractTorrentHash(data);

            if (!hash) {
                hash = extractTorrentHash(event);
            }

            if (!hash && magnet) {
                hash = magnetHash(magnet);
            }

            var title = data.Title ||
                data.title ||
                data.name ||
                data.Name ||
                '';

            log('Событие torrent render:', event);
            log('Данные элемента:', data);
            log('Найден magnet:', magnet);
            log('Найден hash:', hash);

            var config = cfg();
            var alwaysShow = config.always_show_buttons;

            var actions = document.createElement('div');
            actions.className = 'qbit-direct-actions';

            var downloadIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

            var playIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

            var deleteIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

            var addButton;
            var playerButton;
            var deleteButton;

            addButton = createButton(
                'qbit-direct-add',
                'qB',
                function () {
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
                                    var span = addButton.querySelector(
                                        '.qbit-btn-text'
                                    );

                                    if (span) {
                                        span.textContent =
                                            Math.floor(progress * 100) + '%';
                                    }
                                }
                            });
                        }, POLL_INTERVAL);
                    });
                },
                downloadIcon
            );

            playerButton = createButton(
                'qbit-direct-player',
                '',
                function () {
                    // Повторно извлекаем хеш при нажатии,
                    // если он не был найден при создании кнопки.
                    var currentHash = hash ||
                        extractTorrentHash(data) ||
                        extractTorrentHash(event) ||
                        magnetHash(magnet);

                    log('Нажата кнопка Плеер. Хеш:', currentHash);

                    handlePlayerButton(currentHash);
                },
                playIcon
            );

            deleteButton = createButton(
                'qbit-direct-delete',
                '',
                function () {
                    var currentMagnet = magnet ||
                        extractMagnet(data) ||
                        extractMagnet(event);

                    if (!currentMagnet && hash) {
                        currentMagnet = hash;
                    }

                    qbDelete(currentMagnet);
                },
                deleteIcon
            );

            if (!alwaysShow) {
                playerButton.style.display = 'none';
                deleteButton.style.display = 'none';
            }

            actions.appendChild(addButton);
            actions.appendChild(playerButton);
            actions.appendChild(deleteButton);

            container.appendChild(actions);
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
                'overflow:visible !important;' +
                'margin-right:32px !important;' +
            '}' +

            '.qbit-direct-actions {' +
                'display:flex;' +
                'flex-direction:column;' +
                'justify-content:center;' +
                'align-items:center;' +
                'position:absolute;' +
                'right:-32px;' +
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
            log('SMB:', cfg().smb_file);
            log('Плагин загружен');

        } catch (error) {
            console.error('[qBittorrent] Initialization error:', error);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', function () {
            initializePlugin();
        });
    }

})();
