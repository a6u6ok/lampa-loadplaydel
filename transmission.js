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
    var DEF_PLAYER_PACKAGE = '';
    var DEF_SMB_FILE = 'smb://192.168.1.50/Media/';

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 5000;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

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

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (error) {}
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
        var match = /urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');
        return match ? match[1].toLowerCase() : '';
    }

    // ================= ПЕРЕХВАТ ANDROIDJS.HTTPREQ =================
    // Оборачиваем оригинальный метод, чтобы узнать его реальную сигнатуру.
    // Плагин будет вызывать нашу обёртку, которая пытается определить,
    // как именно Lampa ожидает аргументы.

    var httpReqSignatures = [];

    function setupHttpReqInterceptor() {
        if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
            console.warn('[qBittorrent] AndroidJS.httpReq недоступен');
            return;
        }

        var originalHttpReq = AndroidJS.httpReq;
        var interceptorInstalled = false;

        // Не переопределяем, если уже перехвачен
        if (AndroidJS.__qbit_intercepted) return;

        AndroidJS.httpReq = function () {
            var args = Array.prototype.slice.call(arguments);

            // Запоминаем сигнатуру (типы аргументов) для анализа
            var signature = args.map(function (a) {
                if (typeof a === 'string') {
                    // Определяем, похоже ли на JSON или URL
                    if (a.trim().startsWith('{') || a.trim().startsWith('[')) return 'json';
                    if (a.indexOf('http') === 0) return 'url';
                    return 'string';
                }
                return typeof a;
            }).join(',');

            if (httpReqSignatures.indexOf(signature) === -1) {
                httpReqSignatures.push(signature);
                console.log('[qBittorrent] Обнаружена сигнатура httpReq:', signature);
            }

            // Вызываем оригинальный метод с теми же аргументами
            return originalHttpReq.apply(AndroidJS, args);
        };

        AndroidJS.__qbit_intercepted = true;
        console.log('[qBittorrent] Перехват AndroidJS.httpReq установлен');
    }

    // ================= HTTP ЗАПРОСЫ =================

    function nativeRequest(request, callback) {
        var responded = false;

        function finish(response) {
            if (responded) return;
            responded = true;

            if (response === null || response === undefined) {
                // Пробуем fetch как последний шанс
                fetchRequest(request, callback);
                return;
            }

            callback(response);
        }

        // Собираем возможные варианты вызова
        var attempts = [
            function () {
                AndroidJS.httpReq(JSON.stringify(request));
            },
            function () {
                AndroidJS.httpReq(
                    request.url,
                    JSON.stringify({
                        method: request.method,
                        body: request.body || '',
                        headers: request.headers || {}
                    })
                );
            },
            function () {
                AndroidJS.httpReq(request.url, request.method, request.body || '');
            },
            function () {
                AndroidJS.httpReq(
                    request.url,
                    request.method,
                    request.headers || {},
                    request.body || ''
                );
            },
            function () {
                AndroidJS.httpReq(request.url, request.method, request.body || '', request.headers || {});
            },
            function () {
                AndroidJS.httpReq(request);
            }
        ];

        var currentAttempt = 0;

        function tryNext() {
            if (responded) return;

            if (currentAttempt >= attempts.length) {
                console.warn('[qBittorrent] Все сигнатуры httpReq исчерпаны, пробуем fetch');
                finish(null);
                return;
            }

            var fn = attempts[currentAttempt];
            currentAttempt++;

            // Очищаем буфер ответа
            try { AndroidJS.getResp(); } catch (e) {}

            try {
                fn();
            } catch (e) {
                console.warn('[qBittorrent] httpReq попытка ' + currentAttempt + ' выбросила ошибку:', e);
                setTimeout(tryNext, 100);
                return;
            }

            var tries = 0;
            var maxTries = 20; // 20 × 150 мс = 3 секунды

            (function poll() {
                if (responded) return;

                tries++;

                var response = null;
                try {
                    response = AndroidJS.getResp();
                } catch (e) {}

                if (typeof response === 'string' && response.length > 2) {
                    finish(response);
                    return;
                }

                if (tries >= maxTries) {
                    console.warn('[qBittorrent] httpReq попытка ' + currentAttempt + ' не вернула ответ');
                    tryNext();
                    return;
                }

                setTimeout(poll, 150);
            })();
        }

        if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
            finish(null);
            return;
        }

        tryNext();
    }

    // Резервный запрос через fetch
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
                callback(text);
            })
            .catch(function (error) {
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
            if (finalSavePath) {
                finalSavePath = joinPath(finalSavePath, config.category);
            } else {
                autoTMM = true;
            }
        }

        if (finalSavePath) body += '&savepath=' + encodeURIComponent(finalSavePath);
        if (config.category) body += '&category=' + encodeURIComponent(config.category);
        if (config.rename && title) body += '&rename=' + encodeURIComponent(title);

        body += '&paused=false&stopped=false';
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');
        return body;
    }

    function confirmAdded(magnet, callback) {
        var hash = magnetHash(magnet);
        if (!hash) {
            callback(false);
            return;
        }

        nativeRequest({
            url: base() + '/api/v2/torrents/info?hashes=' + hash,
            method: 'GET'
        }, function (response) {
            callback(typeof response === 'string' && response.toLowerCase().indexOf(hash) !== -1);
        });
    }

    function qbAdd(magnet, title) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Magnet-ссылка не найдена');
            return;
        }

        var config = cfg();
        var body = buildAddBody(magnet, title);
        debugNotify('Отправляю в qBittorrent...');

        function finishAdd(response) {
            if (response === null || response === undefined) {
                notify('Не удалось получить ответ от qBittorrent');
                return;
            }

            if (/Forbidden|403/i.test(response)) {
                notify('qBittorrent: 403. Проверь доступ к Web UI');
                return;
            }
            if (/Fails/i.test(response)) {
                notify('qBittorrent: ошибка добавления');
                return;
            }

            if (config.confirm) {
                confirmAdded(magnet, function (added) {
                    notify(added ? 'Добавлено в qBittorrent ✓' : 'Отправлено, подтверждение не получено');
                });
            } else {
                notify('Отправлено в qBittorrent');
            }
        }

        function addRequest() {
            nativeRequest({
                url: base() + '/api/v2/torrents/add',
                method: 'POST',
                body: body,
                headers: CT_FORM
            }, finishAdd);
        }

        if (!config.bypass && config.user) {
            nativeRequest({
                url: base() + '/api/v2/auth/login',
                method: 'POST',
                body: 'username=' + encodeURIComponent(config.user) + '&password=' + encodeURIComponent(config.pass),
                headers: CT_FORM
            }, addRequest);
        } else {
            addRequest();
        }
    }

    function qbDelete(magnet) {
        var hash = magnetHash(magnet);
        if (!hash) {
            notify('Не удалось определить hash торрента');
            return;
        }

        var config = cfg();
        var body = 'hashes=' + encodeURIComponent(hash) + '&deleteFiles=' + (config.delete_files ? 'true' : 'false');
        debugNotify('Удаляю торрент из qBittorrent...');

        function finishDelete(response) {
            if (response === null || response === undefined) {
                notify('Не удалось получить ответ от qBittorrent');
                return;
            }
            if (/Forbidden|403/i.test(response)) {
                notify('qBittorrent: 403. Проверь доступ к Web UI');
                return;
            }
            notify(config.delete_files ? 'Торрент и файлы удалены' : 'Торрент удалён');
        }

        function deleteRequest() {
            nativeRequest({
                url: base() + '/api/v2/torrents/delete',
                method: 'POST',
                body: body,
                headers: CT_FORM
            }, finishDelete);
        }

        if (!config.bypass && config.user) {
            nativeRequest({
                url: base() + '/api/v2/auth/login',
                method: 'POST',
                body: 'username=' + encodeURIComponent(config.user) + '&password=' + encodeURIComponent(config.pass),
                headers: CT_FORM
            }, deleteRequest);
        } else {
            deleteRequest();
        }
    }

    // ================= ПРОВЕРКА СТАТУСА ТОРРЕНТА =================

    function checkTorrentReady(hash, callback) {
        if (!hash) {
            callback(false);
            return;
        }

        nativeRequest({
            url: base() + '/api/v2/torrents/info?hashes=' + hash,
            method: 'GET'
        }, function (response) {
            if (typeof response !== 'string' || !response.length) {
                callback(false);
                return;
            }

            try {
                var data = JSON.parse(response);
                var torrents = data.torrents || data || [];
                if (!Array.isArray(torrents) || !torrents.length) {
                    callback(false);
                    return;
                }

                var t = torrents[0];
                var ready =
                    (typeof t.progress === 'number' && t.progress >= 1) ||
                    (t.state && /^(uploading|stalledUP|pausedUP|queuedUP|forcedUP)$/i.test(t.state));

                callback(!!ready);
            } catch (e) {
                console.warn('[qBittorrent] parse torrent info failed:', e);
                callback(false);
            }
        });
    }

    // ================= ОТКРЫТИЕ ФАЙЛА В ПЛЕЕРЕ =================

    function openFileInPlayer(fileUri, playerPkg) {
        var uri = String(fileUri || '').trim();
        var pkg = String(playerPkg || '').trim();

        if (!uri) {
            notify('Укажите SMB-путь к файлу в настройках');
            return;
        }

        debugNotify('Открываю: ' + uri + ' (' + (pkg || 'выбор') + ')');

        try {
            if (window.Lampa && Lampa.Android && typeof Lampa.Android.openPlayer === 'function') {
                Lampa.Android.openPlayer(uri, { package: pkg, title: '' });
                return;
            }
        } catch (e) {}

        try {
            if (window.AndroidJS && typeof AndroidJS.openPlayer === 'function') {
                AndroidJS.openPlayer(uri, pkg, '', 'video/*');
                return;
            }
        } catch (e) {}

        try {
            if (window.AndroidJS && typeof AndroidJS.startActivity === 'function') {
                AndroidJS.startActivity(JSON.stringify({
                    action: 'android.intent.action.VIEW',
                    data: uri,
                    type: 'video/*',
                    package: pkg
                }));
                return;
            }
        } catch (e) {}

        try {
            if (window.Android && typeof Android.openPlayer === 'function') {
                Android.openPlayer(uri, { package: pkg, title: '' });
                return;
            }
        } catch (e) {}

        notify('Не удалось открыть файл в плеере');
    }

    function handlePlayerButton() {
        var config = cfg();
        if (!config.player_package || config.player_package === 'custom') {
            notify('Плеер не выбран. Зайдите в настройки qBittorrent.');
            return;
        }
        openFileInPlayer(config.smb_file, config.player_package);
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
                if (event.stopImmediatePropagation) event.stopImmediatePropagation();
            }
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

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_url', type: 'input', values: '', default: DEF_URL },
                field: { name: 'Адрес сервера', description: 'http://192.168.1.50:8080' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_user', type: 'input', values: '', default: DEF_USER },
                field: { name: 'Логин', description: 'Логин Web UI' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_pass', type: 'input', values: '', default: DEF_PASS },
                field: { name: 'Пароль', description: 'Пароль Web UI' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_bypass', type: 'trigger', default: DEF_BYPASS },
                field: { name: 'Обход аутентификации', description: 'Для локальной сети' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_savepath', type: 'input', values: '', default: DEF_SAVEPATH },
                field: { name: 'Базовый путь сохранения', description: '/app/qBittorrent' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_category', type: 'input', values: '', default: DEF_CATEGORY },
                field: { name: 'Категория', description: 'video' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_auto_cat_path', type: 'trigger', default: DEF_AUTO_CAT_PATH },
                field: { name: 'Добавлять категорию к пути', description: '' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_rename', type: 'trigger', default: DEF_RENAME },
                field: { name: 'Переименовывать торрент', description: '' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_confirm', type: 'trigger', default: DEF_CONFIRM },
                field: { name: 'Проверять добавление', description: '' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_delete_files', type: 'trigger', default: DEF_DELETE_FILES },
                field: { name: 'Удалять файлы торрента', description: '' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_player_package', type: 'select', values: PLAYERS_LIST, default: '' },
                field: { name: 'Видеоплеер', description: 'Выберите плеер' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_smb_file', type: 'input', values: '', default: DEF_SMB_FILE },
                field: { name: 'SMB-путь к файлу или папке', description: 'smb://192.168.1.50/Media/' }
            });

            console.log('[qBittorrent] Настройки зарегистрированы');
        } catch (error) {
            console.error('[qBittorrent] Ошибка регистрации настроек:', error);
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

    function updateActionButtons(item, hash) {
        var actions = item.querySelector('.qbit-direct-actions');
        if (!actions) return;

        var playerBtn = actions.querySelector('.qbit-direct-player');
        var deleteBtn = actions.querySelector('.qbit-direct-delete');

        function setVisible(btn, visible) {
            if (!btn) return;
            if (visible) btn.classList.remove('qbit-hidden');
            else btn.classList.add('qbit-hidden');
        }

        checkTorrentReady(hash, function (ready) {
            setVisible(playerBtn, ready);
            setVisible(deleteBtn, ready);
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

            if (DEBUG) console.log('[qBittorrent] torrent card data:', data, 'hash:', hash);

            var actions = document.createElement('div');
            actions.className = 'qbit-direct-actions';

            var addButton = createButton('qbit-direct-add', '⬇ В qBittorrent', function () {
                qbAdd(magnet, title);
            });

            var playerButton = createButton('qbit-direct-player qbit-hidden', '▶ Открыть плеер', function () {
                handlePlayerButton();
            });

            var deleteButton = createButton('qbit-direct-delete qbit-hidden', '🗑 Удалить', function () {
                qbDelete(magnet);
            });

            actions.appendChild(addButton);
            actions.appendChild(playerButton);
            actions.appendChild(deleteButton);

            item.appendChild(actions);

            if (hash) {
                updateActionButtons(item, hash);

                var pollTimer = setInterval(function () {
                    if (!document.body.contains(item)) {
                        clearInterval(pollTimer);
                        return;
                    }
                    checkTorrentReady(hash, function (ready) {
                        if (ready) {
                            updateActionButtons(item, hash);
                            clearInterval(pollTimer);
                        }
                    });
                }, POLL_INTERVAL);
            }
        });
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            console.log('[qBittorrent] Инициализация плагина...');

            // Устанавливаем перехват httpReq до первых запросов
            setupHttpReqInterceptor();

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
                    '.qbit-direct-player{background:#1f4b3a;border-color:#3fae7a;}' +
                    '.qbit-direct-player.focus{background:#2c6b51;}' +
                    '.qbit-direct-delete{background:#4b2323;border-color:#ae3f3f;}' +
                    '.qbit-direct-delete.focus{background:#6b2c2c;}' +
                    '.qbit-hidden{display:none !important;}';
                document.head.appendChild(style);
            }
            console.log('[qBittorrent] Плагин загружен');
        } catch (error) {
            console.error('[qBittorrent] Ошибка инициализации:', error);
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
