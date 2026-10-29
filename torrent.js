// ============================================================================
// Плагин qBittorrent для Lampa.
// ============================================================================

(function () {
    'use strict';

    // ================= ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =================

    var DEF_URL = 'http://192.168.1.50:8080';
    var DEF_USER = '';
    var DEF_PASS = '';
    var DEF_BYPASS = true;
    var DEF_SAVEPATH = '';
    var DEF_CATEGORY = '';
    var DEF_RENAME = true;
    var DEF_CONFIRM = true;
    var DEF_AUTO_CAT_PATH = true;
    var DEF_DELETE_FILES = false;
    var DEF_FILEMANAGER_PACKAGE = '';
    var DEF_CUSTOM_FILEMANAGER_PACKAGE = '';
    var DEF_ALWAYS_SHOW_BUTTONS = false; 

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    var FILEMANAGERS_LIST = {
        '': 'Не выбран',
        'com.android.documentsui': 'Файловый менеджер Android',
        'com.mi.android.globalFileexplorer': 'Проводник (Xiaomi)',
        'com.google.android.documentsui': 'Files by Google',
        'com.ghisler.android.TotalCommander': 'Total Commander',
        'com.estrongs.android.pop': 'ES Проводник',
        'com.speedsoftware.rootexplorer': 'Root Explorer',
        'com.lonelycatgames.Xplore': 'X-plore',
        'com.mxtech.videoplayer.ad': 'MX Player (встроенный)',
        'custom': 'Другой (указать пакет ниже)'
    };

    // ================= УТИЛИТЫ =================

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
            filemanager_package: storeGet('qbit_filemanager_package', DEF_FILEMANAGER_PACKAGE),
            custom_filemanager_package: storeGet('qbit_custom_filemanager_package', DEF_CUSTOM_FILEMANAGER_PACKAGE),
            always_show_buttons: isTrue(storeGet('qbit_always_show_buttons', DEF_ALWAYS_SHOW_BUTTONS), DEF_ALWAYS_SHOW_BUTTONS)
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
        var match = /urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');
        return match ? match[1].toLowerCase() : '';
    }

    // ================= HTTP ЗАПРОСЫ =================

    function nativeRequest(request, callback) {
        var responded = false;

        function finish(response) {
            if (responded) return;
            responded = true;
            if (response === null || response === undefined) {
                fetchRequest(request, callback);
                return;
            }
            callback(response);
        }

        if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
            fetchRequest(request, callback);
            return;
        }

        try { AndroidJS.getResp(); } catch (error) {}
        try {
            AndroidJS.httpReq(JSON.stringify(request));
        } catch (e) {
            try {
                AndroidJS.httpReq(request.url, JSON.stringify({ method: request.method, body: request.body || '', headers: request.headers || {} }));
            } catch (e2) {
                fetchRequest(request, callback);
                return;
            }
        }

        var tries = 0;
        (function poll() {
            if (responded) return;
            tries++;
            var response = null;
            try { response = AndroidJS.getResp(); } catch (error) {}
            if (typeof response === 'string' && response.length > 2) {
                finish(response);
                return;
            }
            if (tries >= 20) {
                finish(null);
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
        fetch(request.url, {
            method: request.method || 'GET',
            headers: request.headers || CT_FORM,
            credentials: 'include',
            body: request.body
        }).then(function (res) { return res.text(); }).then(function (text) { callback(text); }).catch(function (error) {
            console.error('[qBittorrent] fetch error:', error);
            callback(null);
        });
    }

    // ================= QBITTORRENT =================

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
        body += '&paused=false&stopped=false';
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');
        return body;
    }

    function qbAdd(magnet, title, onComplete) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) return;
        var config = cfg();
        var body = buildAddBody(magnet, title);
        debugNotify('Отправляю в qBittorrent...');

        function finishAdd(response) {
            if (response === null) return; 
            if (/Forbidden|403/i.test(response)) { console.error('403 Forbidden'); return; }
            if (/Fails/i.test(response)) { console.error('Add failed'); return; }
            notify('Отправлено в qBittorrent');
            if (onComplete) onComplete();
        }

        function addRequest() {
            nativeRequest({ url: base() + '/api/v2/torrents/add', method: 'POST', body: body, headers: CT_FORM }, finishAdd);
        }

        if (!config.bypass && config.user) {
            nativeRequest({ url: base() + '/api/v2/auth/login', method: 'POST', body: 'username=' + encodeURIComponent(config.user) + '&password=' + encodeURIComponent(config.pass), headers: CT_FORM }, addRequest);
        } else {
            addRequest();
        }
    }

    function qbDelete(magnet) {
        var hash = magnetHash(magnet);
        if (!hash) return;
        var config = cfg();
        var body = 'hashes=' + encodeURIComponent(hash) + '&deleteFiles=' + (config.delete_files ? 'true' : 'false');
        debugNotify('Удаляю торрент...');

        function finishDelete(response) {
            if (response === null) return;
            if (/Forbidden|403/i.test(response)) { console.error('403 Forbidden on delete'); return; }
            notify('Торрент удалён');
        }

        function deleteRequest() {
            nativeRequest({ url: base() + '/api/v2/torrents/delete', method: 'POST', body: body, headers: CT_FORM }, finishDelete);
        }

        if (!config.bypass && config.user) {
            nativeRequest({ url: base() + '/api/v2/auth/login', method: 'POST', body: 'username=' + encodeURIComponent(config.user) + '&password=' + encodeURIComponent(config.pass), headers: CT_FORM }, deleteRequest);
        } else {
            deleteRequest();
        }
    }

    // ================= ЗАПУСК ПРИЛОЖЕНИЯ =================

    function launchFileManagerApp() {
        var config = cfg();
        var pkg = config.filemanager_package;
        
        if (pkg === 'custom') pkg = config.custom_filemanager_package;
        pkg = String(pkg || '').trim();

        if (!pkg) {
            notify('Укажите пакет файлового менеджера в настройках');
            return;
        }

        debugNotify('Запускаю приложение: ' + pkg);

        // Способ 1: startActivity с MAIN/LAUNCHER
        try {
            if (window.AndroidJS && typeof AndroidJS.startActivity === 'function') {
                AndroidJS.startActivity(JSON.stringify({
                    action: 'android.intent.action.MAIN',
                    category: 'android.intent.category.LAUNCHER',
                    package: pkg
                }));
                return;
            }
        } catch (e) {
            console.error('[qBittorrent] startActivity error:', e);
        }

        // Способ 2: openUrl с intent://
        try {
            if (window.AndroidJS && typeof AndroidJS.openUrl === 'function') {
                var intentUrl = 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=' + pkg + ';end';
                AndroidJS.openUrl(intentUrl);
                return;
            }
        } catch (e) {
            console.error('[qBittorrent] openUrl error:', e);
        }

        // Способ 3: Lampa.Android.openUrl
        try {
            if (window.Lampa && Lampa.Android && typeof Lampa.Android.openUrl === 'function') {
                var intentUrl2 = 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=' + pkg + ';end';
                Lampa.Android.openUrl(intentUrl2);
                return;
            }
        } catch (e) {
            console.error('[qBittorrent] Lampa.Android.openUrl error:', e);
        }

        // Способ 4: открываем магазин приложений, если не удалось запустить
        notify('Не удалось запустить. Проверьте пакет.');
    }

    // ================= НАЖАТИЯ =================

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

    // ================= РЕГИСТРАЦИЯ НАСТРОЕК =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) return;

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_url', type: 'input', values: '', default: DEF_URL }, field: { name: 'Адрес сервера', description: 'http://192.168.1.50:8080' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_user', type: 'input', values: '', default: DEF_USER }, field: { name: 'Логин', description: 'Логин Web UI' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_pass', type: 'input', values: '', default: DEF_PASS }, field: { name: 'Пароль', description: 'Пароль Web UI' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_bypass', type: 'trigger', default: DEF_BYPASS }, field: { name: 'Обход аутентификации', description: 'Для локальной сети' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_savepath', type: 'input', values: '', default: DEF_SAVEPATH }, field: { name: 'Базовый путь сохранения', description: '/app/qBittorrent' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_category', type: 'input', values: '', default: DEF_CATEGORY }, field: { name: 'Категория', description: 'video' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_auto_cat_path', type: 'trigger', default: DEF_AUTO_CAT_PATH }, field: { name: 'Добавлять категорию к пути', description: '' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_rename', type: 'trigger', default: DEF_RENAME }, field: { name: 'Переименовывать торрент', description: '' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_confirm', type: 'trigger', default: DEF_CONFIRM }, field: { name: 'Проверять добавление', description: '' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_delete_files', type: 'trigger', default: DEF_DELETE_FILES }, field: { name: 'Удалять файлы торрента', description: '' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_always_show_buttons', type: 'trigger', default: DEF_ALWAYS_SHOW_BUTTONS }, field: { name: 'Всегда показывать Открыть и Удалить', description: 'Не скрывать кнопки и не менять текст кнопки добавления на проценты' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_filemanager_package', type: 'select', values: FILEMANAGERS_LIST, default: '' }, field: { name: 'Файловый менеджер', description: 'Выберите приложение для кнопки "Открыть"' }});
            Lampa.SettingsApi.addParam({ component: 'qbit_direct', param: { name: 'qbit_custom_filemanager_package', type: 'input', values: '', default: DEF_CUSTOM_FILEMANAGER_PACKAGE }, field: { name: 'Пакет своего менеджера', description: 'Если выбрано "Другой", впишите пакет сюда' }});
            console.log('[qBittorrent] Настройки зарегистрированы');
        } catch (error) {
            console.error('Ошибка регистрации настроек:', error);
        }
    }

    // ================= ПУНКТ МЕНЮ =================

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu || typeof Lampa.Menu.addButton !== 'function') return;
            var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_direct"]');
                    if (item) item.click();
                }, 100);
            });
        } catch (error) {}
    }

    // ================= КНОПКИ В КАРТОЧКЕ =================

    function createButton(className, text, handler) {
        var button = document.createElement('div');
        button.className = 'qbit-direct-btn ' + className + ' selector';
        button.tabIndex = 0;
        button.textContent = text;
        bindPress(button, handler);
        return button;
    }

    function checkTorrentProgress(hash, onProgress) {
        if (!hash) return;
        nativeRequest({ url: base() + '/api/v2/torrents/info?hashes=' + hash, method: 'GET' }, function (response) {
            if (typeof response !== 'string' || !response.length) return;
            try {
                var data = JSON.parse(response);
                var torrents = data.torrents || data;
                if (Array.isArray(torrents) && torrents.length > 0) onProgress(torrents[0].progress);
            } catch (error) {}
        });
    }

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;

        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render' || !event.item) return;
            var item = event.item.jquery ? event.item[0] : event.item;
            var data = event.element || {};
            if (!item || item.querySelector('.qbit-direct-actions')) return;

            var magnet = data.MagnetUri || data.magnetUri || '';
            var title = data.Title || data.title || '';
            var hash = magnetHash(magnet);
            var config = cfg();
            var alwaysShow = config.always_show_buttons;

            var actions = document.createElement('div');
            actions.className = 'qbit-direct-actions';

            var addButton = createButton('qbit-direct-add', 'qB qBittorrent', function () {
                if (alwaysShow) { qbAdd(magnet, title); return; }
                addButton.textContent = '⏳ 0%';
                addButton.classList.add('qbit-loading');
                qbAdd(magnet, title, function() {
                    if (!hash) return;
                    var pollTimer = setInterval(function () {
                        if (!document.body.contains(item)) { clearInterval(pollTimer); return; }
                        checkTorrentProgress(hash, function (progress) {
                            if (progress >= 1) {
                                clearInterval(pollTimer);
                                addButton.style.display = 'none';
                                playerButton.style.display = 'inline-flex';
                                deleteButton.style.display = 'inline-flex';
                                notify('Загрузка завершена!');
                            } else {
                                addButton.textContent = '⏳ ' + Math.floor(progress * 100) + '%';
                            }
                        });
                    }, POLL_INTERVAL);
                });
            });

            var playerButton = createButton('qbit-direct-player', '📁 Открыть', function () { launchFileManagerApp(); });
            var deleteButton = createButton('qbit-direct-delete', '🗑 Удалить', function () { qbDelete(magnet); });

            if (!alwaysShow) {
                playerButton.style.display = 'none';
                deleteButton.style.display = 'none';
            }

            actions.appendChild(addButton);
            actions.appendChild(playerButton);
            actions.appendChild(deleteButton);
            item.appendChild(actions);
        });
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            console.log('[qBittorrent] Инициализация...');
            registerSettings();
            addMenuItem();
            initTorrentButton();

            if (!document.getElementById('qbit-direct-style')) {
                var style = document.createElement('style');
                style.id = 'qbit-direct-style';
                style.textContent =
                    '.qbit-direct-actions{display:inline-flex;align-items:center;position:relative;z-index:999;flex-wrap:wrap;}' +
                    '.qbit-direct-btn{display:inline-flex;align-items:center;justify-content:center;margin:8px;padding:10px 18px;background:#303638;color:white;border:2px solid #888;border-radius:6px;font-size:18px;white-space:nowrap;}' +
                    '.qbit-direct-btn.focus{border-color:white;background:#51595c;}' +
                    '.qbit-direct-add{background:#1f4b3a;border-color:#3fae7a;}' +
                    '.qbit-direct-add.focus{background:#2c6b51;}' +
                    '.qbit-direct-player{background:#2a3a4a;border-color:#5a8ab0;}' +
                    '.qbit-direct-player.focus{background:#3a5a7a;}' +
                    '.qbit-direct-delete{background:#4b2323;border-color:#ae3f3f;}' +
                    '.qbit-direct-delete.focus{background:#6b2c2c;}' +
                    '.qbit-loading{opacity:0.7;pointer-events:none;}';
                document.head.appendChild(style);
            }
        } catch (error) {}
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', function () { initializePlugin(); });
    }
})();
