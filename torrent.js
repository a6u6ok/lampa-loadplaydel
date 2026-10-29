// ============================================================================
// Плагин qBittorrent для Lampa (Fetch версия).
// ============================================================================

(function () {
    'use strict';

    // ================= ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =================
    var DEF_URL = 'http://192.168.1.1:9080'; // Укажите ваш порт
    var DEF_USER = 'admin';
    var DEF_PASS = 'adminadmin';
    var DEF_BYPASS = true;
    var DEF_SAVEPATH = '';
    var DEF_CATEGORY = '';
    var DEF_RENAME = true;
    var DEF_CONFIRM = true;
    var DEF_AUTO_CAT_PATH = true;
    var DEF_DELETE_FILES = false;
    var DEF_PLAYER_PACKAGE = '';
    var DEF_SMB_FILE = 'smb://192.168.1.1/download/';

    var ACTION_LOCK_MS = 1200;
    var CONFIRM_ATTEMPTS = 5;
    var CONFIRM_DELAY_MS = 1500;

    var PLAYERS_LIST = {
        '': 'Не выбран',
        'net.gtvbox.videoplayer': 'Vimu Player',
        'org.videolan.vlc': 'VLC (Android)',
        'top.rootu.dddplayer': 'DDD Video Player',
        'com.mxtech.videoplayer.ad': 'MX Player',
        'com.brouken.player': 'Just (Video) Player',
        'org.xbmc.kodi': 'Kodi',
        'com.newin.nplayer.pro': 'nPlayer',
        'com.xplayer.player': 'Xplayer',
        'org.courville.nova': 'Nova Video Player',
        'com.archos.mediacenter.video': 'Archos Video Player',
        'custom': 'Другой (ввести вручную)'
    };

    var QBIT_SID = '';
    var QBIT_SID_TIME = 0;
    var SID_LIFETIME_MS = 30 * 60 * 1000;

    // ================= УТИЛИТЫ =================
    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (error) {}
        console.log('[qBittorrent]', text);
    }

    function debugLog(label, value) {
        console.log('[qBittorrent] ' + label + ':', value);
    }

    function storeGet(key, defaultValue) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var value = Lampa.Storage.get(key, defaultValue);
                if (value !== undefined && value !== null) return value;
            }
        } catch (error) {}
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
            smb_file: storeGet('qbit_smb_file', DEF_SMB_FILE)
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    function joinPath(basePath, subPath) {
        if (!basePath) return subPath || '';
        if (!subPath) return basePath;
        return String(basePath).replace(/\/+$/, '') + '/' + String(subPath).replace(/^\/+/, '');
    }

    function magnetHash(magnet) {
        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(magnet || '');
        return match ? match[1].toLowerCase() : '';
    }

    function encodePathSegments(path) {
        return String(path || '').split('/').filter(function (part) { return part !== ''; })
            .map(function (part) { return encodeURIComponent(part); }).join('/');
    }

    function isVideoFile(name) {
        return /\.(mp4|mkv|avi|mov|m4v|ts|webm|wmv|flv|mpg|mpeg|vob|3gp)$/i.test(name || '');
    }

    // ================= HTTP ЗАПРОСЫ (FETCH) =================
    function fetchRequest(url, method, body, callback) {
        var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (QBIT_SID) headers['Cookie'] = 'SID=' + QBIT_SID;

        fetch(base() + url, {
            method: method || 'GET',
            headers: headers,
            body: body || null
        }).then(function (response) {
            // Перехватываем SID из заголовков
            var setCookie = response.headers.get('set-cookie');
            if (setCookie) {
                var match = /SID=([^;]+)/i.exec(setCookie);
                if (match) {
                    QBIT_SID = match[1];
                    QBIT_SID_TIME = Date.now();
                }
            }
            return response.text().then(function (text) {
                callback(text, response.status);
            });
        }).catch(function (error) {
            debugLog('Fetch Error', error);
            callback(null, 500);
        });
    }

    // ================= АВТОРИЗАЦИЯ =================
    function sidIsValid() {
        return QBIT_SID && (Date.now() - QBIT_SID_TIME) < SID_LIFETIME_MS;
    }

    function qbLogin(callback) {
        var config = cfg();
        if (!config.user) { callback(false); return; }
        var body = 'username=' + encodeURIComponent(config.user) + '&password=' + encodeURIComponent(config.pass);

        fetchRequest('/api/v2/auth/login', 'POST', body, function (response) {
            var ok = !!response && /Ok/i.test(response);
            callback(ok);
        });
    }

    function ensureAuth(callback) {
        var config = cfg();
        if (config.bypass || !config.user) { callback(true); return; }
        if (sidIsValid()) { callback(true); return; }
        qbLogin(callback);
    }

    function makeApiRequest(url, method, body, callback, retry) {
        ensureAuth(function (authorized) {
            if (!authorized) { callback(null, 401); return; }
            
            fetchRequest(url, method, body, function (response, status) {
                var isAuthError = status === 403 || (response && /Forbidden/i.test(response));

                if (isAuthError && !retry && !cfg().bypass) {
                    QBIT_SID = ''; QBIT_SID_TIME = 0;
                    qbLogin(function () {
                        makeApiRequest(url, method, body, callback, true);
                    });
                    return;
                }
                callback(response, status);
            });
        });
    }

    function extractJson(response) {
        if (!response) return null;
        try { return JSON.parse(response); } catch (e) {}
        return null;
    }

    // ================= QBITTORRENT API =================
    function buildAddBody(magnet, title) {
        var config = cfg();
        var body = 'urls=' + encodeURIComponent(magnet);
        var finalSavePath = config.savepath || '';
        var autoTMM = false;

        if (config.auto_cat_path && config.category) {
            if (finalSavePath) finalSavePath = joinPath(finalSavePath, config.category);
            else autoTMM = true;
        }
        if (finalSavePath) body += '&savepath=' + encodeURIComponent(finalSavePath);
        if (config.category) body += '&category=' + encodeURIComponent(config.category);
        if (config.rename && title) body += '&rename=' + encodeURIComponent(title);
        
        body += '&stopped=false&autoTMM=' + (autoTMM ? 'true' : 'false');
        return body;
    }

    function findTorrentByMagnet(torrents, magnet, fallbackTitle) {
        if (!Array.isArray(torrents)) return null;
        var magnetLower = String(magnet || '').toLowerCase();
        var magnetHashValue = magnetHash(magnet);
        var titleLower = String(fallbackTitle || '').toLowerCase().trim();

        for (var i = 0; i < torrents.length; i++) {
            var t = torrents[i];
            if (!t) continue;
            
            var tHash = String(t.hash || '').toLowerCase();
            var tV1 = String(t.infohash_v1 || '').toLowerCase();
            var tV2 = String(t.infohash_v2 || '').toLowerCase();

            // Поиск по хэшу (самый надежный)
            if (magnetHashValue && (tHash === magnetHashValue || tV1 === magnetHashValue || tV2 === magnetHashValue)) {
                return t;
            }
            // Поиск по названию
            if (titleLower && String(t.name || '').toLowerCase().trim() === titleLower) {
                return t;
            }
        }
        return null;
    }

    function getTorrentList(callback) {
        makeApiRequest('/api/v2/torrents/info', 'GET', '', function (response) {
            callback(extractJson(response) || []);
        });
    }

    function getTorrentStatus(magnet, fallbackTitle, callback) {
        getTorrentList(function (torrents) {
            callback(findTorrentByMagnet(torrents, magnet, fallbackTitle));
        });
    }

    function getTorrentFiles(hash, callback) {
        makeApiRequest('/api/v2/torrents/files?hash=' + encodeURIComponent(hash), 'GET', '', function (response) {
            callback(extractJson(response) || []);
        });
    }

    function verifyTorrent(magnet, fallbackTitle, attempts, callback) {
        if (attempts <= 0) { callback(false, null); return; }
        getTorrentStatus(magnet, fallbackTitle, function (torrent) {
            if (torrent) { callback(true, torrent); }
            else { setTimeout(function () { verifyTorrent(magnet, fallbackTitle, attempts - 1, callback); }, CONFIRM_DELAY_MS); }
        });
    }

    // ================= ДОБАВЛЕНИЕ И УДАЛЕНИЕ =================
    function qbAdd(magnet, title, onAdded) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) { notify('Magnet-ссылка не найдена'); return; }
        var config = cfg();
        var body = buildAddBody(magnet, title);

        notify('Отправляю торрент в qBittorrent...');

        makeApiRequest('/api/v2/torrents/add', 'POST', body, function (response, status) {
            if (status === 403) { notify('qBittorrent: нет доступа. Проверьте логин/пароль'); return; }
            if (/Fails/i.test(response)) { notify('qBittorrent: ошибка добавления'); return; }

            if (config.confirm) {
                verifyTorrent(magnet, title, CONFIRM_ATTEMPTS, function (found, torrent) {
                    if (found) {
                        notify('Торрент добавлен и подтверждён ✓');
                        if (typeof onAdded === 'function') onAdded(torrent);
                    } else {
                        notify('qBittorrent: торрент не найден после добавления');
                    }
                });
                return;
            }
            notify('Добавлено в qBittorrent ✓');
            if (typeof onAdded === 'function') onAdded();
        });
    }

    function qbDelete(magnet) {
        var hash = magnetHash(magnet);
        if (!hash) { notify('Не удалось определить hash торрента'); return; }
        
        var config = cfg();
        var body = 'hashes=' + encodeURIComponent(hash) + '&deleteFiles=' + (config.delete_files ? 'true' : 'false');
        
        notify('Удаляю торрент из qBittorrent...');
        makeApiRequest('/api/v2/torrents/delete', 'POST', body, function (response, status) {
            if (status === 403) { notify('qBittorrent: нет доступа'); return; }
            notify(config.delete_files ? 'Торрент и файлы удалены' : 'Торрент удалён из qBittorrent');
        });
    }

    // ================= ОТКРЫТИЕ ФАЙЛА В ПЛЕЕРЕ =================
    function pickBestVideoFile(files) {
        var videos = files.filter(function (f) { return f && isVideoFile(f.name); });
        if (!videos.length) return null;
        videos.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
        return videos[0].name;
    }

    function buildSmbUri(folder, relativeFilePath) {
        var root = String(folder || '').trim().replace(/\/+$/, '');
        return root + '/' + encodePathSegments(relativeFilePath);
    }

    function openFileInPlayer(fileUri, playerPkg, fileName) {
        var pkg = String(playerPkg || '').trim();
        if (!fileUri) { notify('Не удалось определить путь к файлу'); return; }

        try {
            if (window.Lampa && Lampa.Android && typeof Lampa.Android.openPlayer === 'function') {
                Lampa.Android.openPlayer(fileUri, { package: pkg, title: fileName });
                return;
            }
        } catch (e) {}

        try {
            if (window.AndroidJS && typeof AndroidJS.openPlayer === 'function') {
                AndroidJS.openPlayer(fileUri, pkg, fileName, 'video/*');
                return;
            }
        } catch (e) {}
        
        notify('Не удалось открыть файл в плеере');
    }

    function handlePlayerButton(magnet, fallbackTitle) {
        var config = cfg();
        if (!config.player_package || config.player_package === 'custom') {
            notify('Плеер не выбран в настройках.'); return;
        }
        notify('Ищу торрент в qBittorrent...');

        getTorrentStatus(magnet, fallbackTitle, function (torrent) {
            if (!torrent) { notify('Торрент не найден в qBittorrent'); return; }

            var state = String(torrent.state || '').toLowerCase();
            // Проверка, что торрент завершен (белый список)
            var isReady = state.indexOf('up') !== -1 || state.indexOf('paused') !== -1 || state === 'queuedup' || state === 'stalledup';
            
            if (!isReady && state.indexOf('dl') === -1 && state.indexOf('checking') === -1 && state.indexOf('downloading') === -1) {
                // Иногда статус странный, лучше попробовать, если не явно качается
                debugLog('Состояние торрента', state);
            }

            getTorrentFiles(torrent.hash, function (files) {
                var relativeFile = pickBestVideoFile(files);
                if (!relativeFile) { notify('В торренте не найден видеофайл'); return; }

                var folder = config.smb_file;
                // Если файлов несколько, добавляем папку торрента
                if (files.length > 1 && torrent.name) {
                    folder = joinPath(folder, torrent.name);
                }

                var uri = buildSmbUri(folder, relativeFile);
                openFileInPlayer(uri, config.player_package, relativeFile);
            });
        });
    }

    // ================= UI =================
    function bindPress(element, handler) {
        var last = 0;
        function wrapped(event) {
            var now = Date.now();
            if (now - last < ACTION_LOCK_MS) return;
            last = now;
            if (event) { event.preventDefault(); event.stopPropagation(); if (event.stopImmediatePropagation) event.stopImmediatePropagation(); }
            handler(event);
        }
        element.addEventListener('hover:enter', wrapped);
        element.addEventListener('click', wrapped);
    }

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) return;
            Lampa.SettingsApi.addComponent({ component: 'qbit_direct', icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>', name: 'qBittorrent (Роутер)' });

            var params = [
                { name: 'qbit_url', type: 'input', def: DEF_URL, title: 'Адрес роутера', desc: 'Например http://192.168.1.1:9080' },
                { name: 'qbit_user', type: 'input', def: DEF_USER, title: 'Логин', desc: 'Логин qBittorrent' },
                { name: 'qbit_pass', type: 'input', def: DEF_PASS, title: 'Пароль', desc: 'Пароль qBittorrent' },
                { name: 'qbit_bypass', type: 'trigger', def: DEF_BYPASS, title: 'Обход аутентификации', desc: 'Для локальной сети' },
                { name: 'qbit_savepath', type: 'input', def: DEF_SAVEPATH, title: 'Путь сохранения', desc: 'Например /opt/var/torrents' },
                { name: 'qbit_category', type: 'input', def: DEF_CATEGORY, title: 'Категория', desc: 'Категория торрентов' },
                { name: 'qbit_auto_cat_path', type: 'trigger', def: DEF_AUTO_CAT_PATH, title: 'Добавлять категорию к пути', desc: 'Автоматическая поддиректория' },
                { name: 'qbit_rename', type: 'trigger', def: DEF_RENAME, title: 'Переименовывать торрент', desc: 'Использовать название раздачи' },
                { name: 'qbit_confirm', type: 'trigger', def: DEF_CONFIRM, title: 'Проверять добавление', desc: 'Искать торрент после добавления' },
                { name: 'qbit_delete_files', type: 'trigger', def: DEF_DELETE_FILES, title: 'Удалять файлы с диска', desc: 'При удалении торрента' },
                { name: 'qbit_smb_file', type: 'input', def: DEF_SMB_FILE, title: 'SMB-путь к папке загрузок', desc: 'Например smb://192.168.1.1/download/' }
            ];

            params.forEach(function (param) {
                Lampa.SettingsApi.addParam({
                    component: 'qbit_direct',
                    param: { name: param.name, type: param.type, values: '', default: param.def },
                    field: { name: param.title, description: param.desc }
                });
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_player_package', type: 'select', values: PLAYERS_LIST, default: DEF_PLAYER_PACKAGE },
                field: { name: 'Видеоплеер (Android TV)', description: 'Выберите плеер' }
            });
        } catch (error) { console.error('[qBittorrent] Ошибка регистрации настроек:', error); }
    }

    function createButton(className, text, handler) {
        var button = document.createElement('div');
        button.className = 'qbit-direct-btn ' + className + ' selector';
        button.tabIndex = 0;
        button.textContent = text;
        bindPress(button, handler);
        return button;
    }

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;
        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render' || !event.item) return;
            var item = event.item.jquery ? event.item[0] : event.item;
            var data = event.element || {};
            var magnet = data.MagnetUri || data.magnetUri || '';
            var fallbackTitle = data.file || data.filename || data.name || data.Title || data.title || '';
            var hash = magnetHash(magnet);

            if (!item || !hash) return;
            if (item.querySelector('.qbit-direct-actions[data-hash="' + hash + '"]')) return;

            var actions = document.createElement('div');
            actions.className = 'qbit-direct-actions';
            actions.setAttribute('data-hash', hash);

            actions.appendChild(createButton('qbit-direct-add', '⬇ В qBittorrent', function () { qbAdd(magnet, fallbackTitle); }));
            actions.appendChild(createButton('qbit-direct-player', '▶ Открыть плеер', function () { handlePlayerButton(magnet, fallbackTitle); }));
            actions.appendChild(createButton('qbit-direct-delete', '🗑 Удалить', function () { qbDelete(magnet); }));

            item.appendChild(actions);
        });
    }

    function initializePlugin() {
        try {
            registerSettings();
            initTorrentButton();
            if (!document.getElementById('qbit-direct-style')) {
                var style = document.createElement('style');
                style.id = 'qbit-direct-style';
                style.textContent = '.qbit-direct-actions{display:inline-flex;align-items:center;position:relative;z-index:999;flex-wrap:wrap;}.qbit-direct-btn{display:inline-flex;align-items:center;justify-content:center;margin:8px;padding:10px 18px;background:#303638;color:white;border:2px solid #888;border-radius:6px;font-size:18px;white-space:nowrap;}.qbit-direct-btn.focus{border-color:white;background:#51595c;}.qbit-direct-player{background:#1f4b3a;border-color:#3fae7a;}.qbit-direct-player.focus{background:#2c6b51;}.qbit-direct-delete{background:#4b2323;border-color:#ae3f3f;}.qbit-direct-delete.focus{background:#6b2c2c;}@media screen and (max-width: 768px){.qbit-direct-btn{font-size:14px;padding:8px 12px;margin:4px;}}';
                document.head.appendChild(style);
            }
            console.log('[qBittorrent Router] Плагин загружен (Fetch версия)');
        } catch (error) { console.error('[qBittorrent Router] Ошибка инициализации:', error); }
    }

    if (window.Lampa && Lampa.Listener) { initializePlugin(); } 
    else { document.addEventListener('appready', function () { initializePlugin(); }); }
})();
