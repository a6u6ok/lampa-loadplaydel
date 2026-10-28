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

    var DEF_PLAYER_PACKAGE = '';
    var DEF_PLAYER_ASK = true;
    var DEF_DELETE_FILES = false;

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    // Запасной список популярных плееров, если Android-мост не отдаёт список
    var FALLBACK_PLAYERS = [
        { package: 'org.videolan.vlc', name: 'VLC' },
        { package: 'com.mxtech.videoplayer.ad', name: 'MX Player' },
        { package: 'com.mxtech.videoplayer.pro', name: 'MX Player Pro' },
        { package: 'com.google.android.youtube', name: 'YouTube' },
        { package: 'ru.kinopoisk', name: 'Кинопоиск' },
        { package: 'com.lampa.player', name: 'Lampa Player' }
    ];

    // ================= УТИЛИТЫ =================

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (error) {
            console.warn('[qBittorrent] notify error:', error);
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
        } catch (error) {}

        return defaultValue;
    }

    function storeSet(key, value) {
        try {
            if (window.Lampa && Lampa.Storage) {
                Lampa.Storage.set(key, value);
            }
        } catch (error) {
            console.warn('[qBittorrent] storeSet error:', error);
        }
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
            auto_cat_path: isTrue(
                storeGet('qbit_auto_cat_path', DEF_AUTO_CAT_PATH),
                DEF_AUTO_CAT_PATH
            ),
            player_package: storeGet('qbit_player_package', DEF_PLAYER_PACKAGE),
            player_ask: isTrue(
                storeGet('qbit_player_ask', DEF_PLAYER_ASK),
                DEF_PLAYER_ASK
            ),
            delete_files: isTrue(
                storeGet('qbit_delete_files', DEF_DELETE_FILES),
                DEF_DELETE_FILES
            )
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    function joinPath(basePath, subPath) {
        if (!basePath) return subPath || '';
        if (!subPath) return basePath;

        return (
            String(basePath).replace(/\/+$/, '') +
            '/' +
            String(subPath).replace(/^\/+/, '')
        );
    }

    function magnetHash(magnet) {
        var match = /urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');

        return match ? match[1].toLowerCase() : '';
    }

    // ================= HTTP ЗАПРОСЫ =================

    function nativeRequest(request, callback) {
        var signature = 0;

        function drain() {
            try {
                AndroidJS.getResp();
            } catch (error) {}
        }

        function attempt() {
            if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
                callback(null);
                return;
            }

            if (signature === 0) {
                try {
                    AndroidJS.httpReq(JSON.stringify(request));
                } catch (error) {
                    signature++;
                    attempt();
                    return;
                }
            } else if (signature === 1) {
                try {
                    AndroidJS.httpReq(
                        request.url,
                        JSON.stringify({
                            method: request.method,
                            body: request.body || '',
                            headers: request.headers || {}
                        })
                    );
                } catch (error) {
                    callback(null);
                    return;
                }
            } else {
                callback(null);
                return;
            }

            var tries = 0;

            (function poll() {
                tries++;

                var response = null;

                try {
                    response = AndroidJS.getResp();
                } catch (error) {}

                if (typeof response === 'string' && response.length) {
                    callback(response);
                    return;
                }

                if (tries > 20) {
                    signature++;
                    attempt();
                    return;
                }

                setTimeout(poll, 150);
            })();
        }

        drain();
        attempt();
    }

    function blindRequest(url, method, body) {
        if (typeof fetch !== 'function') {
            notify('Нет поддержки транспорта: нативный запрос недоступен');
            return;
        }

        fetch(url, {
            method: method,
            mode: 'no-cors',
            headers: CT_FORM,
            body: body
        })
            .then(function () {
                notify('Запрос отправлен, но ответ недоступен для проверки');
            })
            .catch(function (error) {
                console.error('[qBittorrent] blind request error:', error);
                notify('Ошибка отправки запроса в qBittorrent');
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

        console.log('[qBittorrent] add body:', body);

        return body;
    }

    function confirmAdded(magnet, callback) {
        var hash = magnetHash(magnet);

        if (!hash) {
            callback(false);
            return;
        }

        nativeRequest(
            {
                url: base() + '/api/v2/torrents/info?hashes=' + hash,
                method: 'GET'
            },
            function (response) {
                callback(
                    typeof response === 'string' &&
                        response.toLowerCase().indexOf(hash) !== -1
                );
            }
        );
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
                blindRequest(
                    base() + '/api/v2/torrents/add',
                    'POST',
                    body
                );

                return;
            }

            console.log('[qBittorrent] add response:', response);

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
                    notify(
                        added
                            ? 'Добавлено в qBittorrent ✓'
                            : 'Отправлено в qBittorrent, подтверждение не получено'
                    );
                });
            } else {
                notify('Отправлено в qBittorrent');
            }
        }

        function addRequest() {
            nativeRequest(
                {
                    url: base() + '/api/v2/torrents/add',
                    method: 'POST',
                    body: body,
                    headers: CT_FORM
                },
                finishAdd
            );
        }

        if (!config.bypass && config.user) {
            nativeRequest(
                {
                    url: base() + '/api/v2/auth/login',
                    method: 'POST',
                    body:
                        'username=' + encodeURIComponent(config.user) +
                        '&password=' + encodeURIComponent(config.pass),
                    headers: CT_FORM
                },
                addRequest
            );
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
        var body =
            'hashes=' + encodeURIComponent(hash) +
            '&deleteFiles=' + (config.delete_files ? 'true' : 'false');

        debugNotify('Удаляю торрент из qBittorrent...');

        function finishDelete(response) {
            console.log('[qBittorrent] delete response:', response);

            if (response === null || response === undefined) {
                blindRequest(
                    base() + '/api/v2/torrents/delete',
                    'POST',
                    body
                );

                return;
            }

            if (/Forbidden|403/i.test(response)) {
                notify('qBittorrent: 403. Проверь доступ к Web UI');
                return;
            }

            notify(
                config.delete_files
                    ? 'Торрент и файлы удалены из qBittorrent'
                    : 'Торрент удалён из qBittorrent'
            );
        }

        function deleteRequest() {
            nativeRequest(
                {
                    url: base() + '/api/v2/torrents/delete',
                    method: 'POST',
                    body: body,
                    headers: CT_FORM
                },
                finishDelete
            );
        }

        if (!config.bypass && config.user) {
            nativeRequest(
                {
                    url: base() + '/api/v2/auth/login',
                    method: 'POST',
                    body:
                        'username=' + encodeURIComponent(config.user) +
                        '&password=' + encodeURIComponent(config.pass),
                    headers: CT_FORM
                },
                deleteRequest
            );
        } else {
            deleteRequest();
        }
    }

    // ================= СПИСОК ПЛЕЕРОВ =================

    function normalizePlayer(raw) {
        if (!raw) return null;

        if (typeof raw === 'string') {
            return { package: raw, name: raw };
        }

        var pkg =
            raw.package ||
            raw.packageName ||
            raw.id ||
            raw.pkg ||
            '';

        var name =
            raw.name ||
            raw.label ||
            raw.title ||
            raw.appName ||
            pkg;

        if (!pkg) return null;

        return { package: pkg, name: name };
    }

    function parsePlayersResponse(response) {
        if (!response) return null;

        var data = response;

        if (typeof response === 'string') {
            try {
                data = JSON.parse(response);
            } catch (error) {
                return null;
            }
        }

        if (Array.isArray(data)) {
            return data.map(normalizePlayer).filter(Boolean);
        }

        if (data && Array.isArray(data.players)) {
            return data.players.map(normalizePlayer).filter(Boolean);
        }

        if (data && Array.isArray(data.list)) {
            return data.list.map(normalizePlayer).filter(Boolean);
        }

        return null;
    }

    function getInstalledPlayers(callback) {
        var called = false;

        function done(players) {
            if (called) return;
            called = true;

            if (players && players.length) {
                callback(players);
            } else {
                callback(FALLBACK_PLAYERS.slice());
            }
        }

        // Пробуем нативный Android-мост
        try {
            if (window.AndroidJS && typeof AndroidJS.getPlayers === 'function') {
                var result = AndroidJS.getPlayers();

                var parsed = parsePlayersResponse(result);

                if (parsed && parsed.length) {
                    done(parsed);
                    return;
                }

                // Некоторые сборки возвращают ответ асинхронно через getResp
                if (typeof AndroidJS.getResp === 'function') {
                    var tries = 0;

                    (function poll() {
                        tries++;

                        var resp = null;

                        try {
                            resp = AndroidJS.getResp();
                        } catch (error) {}

                        var list = parsePlayersResponse(resp);

                        if (list && list.length) {
                            done(list);
                            return;
                        }

                        if (tries > 10) {
                            done(null);
                            return;
                        }

                        setTimeout(poll, 150);
                    })();

                    return;
                }
            }
        } catch (error) {
            console.warn('[qBittorrent] AndroidJS.getPlayers error:', error);
        }

        // Lampa.Android.getPlayers
        try {
            if (
                window.Lampa &&
                Lampa.Android &&
                typeof Lampa.Android.getPlayers === 'function'
            ) {
                var res2 = Lampa.Android.getPlayers();

                var parsed2 = parsePlayersResponse(res2);

                if (parsed2 && parsed2.length) {
                    done(parsed2);
                    return;
                }
            }
        } catch (error) {
            console.warn('[qBittorrent] Lampa.Android.getPlayers error:', error);
        }

        // Старый Android.getPlayers
        try {
            if (window.Android && typeof Android.getPlayers === 'function') {
                var res3 = Android.getPlayers();

                var parsed3 = parsePlayersResponse(res3);

                if (parsed3 && parsed3.length) {
                    done(parsed3);
                    return;
                }
            }
        } catch (error) {
            console.warn('[qBittorrent] Android.getPlayers error:', error);
        }

        done(null);
    }

    // ================= ВИДЕОПЛЕЕР =================

    function openInPackage(mediaUrl, title, packageName, playerAsk) {
        var playerData = {
            url: mediaUrl,
            title: title || '',
            card: {
                title: title || ''
            }
        };

        try {
            // 1) Прямой вызов Android-моста Lampa с пакетом
            if (
                window.AndroidJS &&
                typeof AndroidJS.openPlayer === 'function'
            ) {
                try {
                    AndroidJS.openPlayer(
                        mediaUrl,
                        JSON.stringify(playerData),
                        packageName || ''
                    );
                } catch (error) {
                    // Fallback: без третьего аргумента
                    AndroidJS.openPlayer(mediaUrl, JSON.stringify(playerData));
                }

                notify(
                    packageName && !playerAsk
                        ? 'Открываю в выбранном плеере'
                        : 'Выбери видеоплеер'
                );

                return true;
            }

            // 2) Lampa.Android.openPlayer
            if (
                window.Lampa &&
                Lampa.Android &&
                typeof Lampa.Android.openPlayer === 'function'
            ) {
                try {
                    Lampa.Android.openPlayer(mediaUrl, playerData, packageName);
                } catch (error) {
                    Lampa.Android.openPlayer(mediaUrl, playerData);
                }

                notify(
                    packageName && !playerAsk
                        ? 'Открываю в выбранном плеере'
                        : 'Выбери видеоплеер'
                );

                return true;
            }

            // 3) Старый интерфейс
            if (
                window.Android &&
                typeof Android.openPlayer === 'function'
            ) {
                try {
                    Android.openPlayer(mediaUrl, playerData, packageName);
                } catch (error) {
                    Android.openPlayer(mediaUrl, playerData);
                }

                notify(
                    packageName && !playerAsk
                        ? 'Открываю в выбранном плеере'
                        : 'Выбери видеоплеер'
                );

                return true;
            }
        } catch (error) {
            console.error('[qBittorrent] player open error:', error);
        }

        return false;
    }

    function showPlayerPicker(players, mediaUrl, title) {
        if (!players || !players.length) {
            notify('Список плееров пуст');
            return;
        }

        // Предпочитаем нативный UI Lampa
        if (
            window.Lampa &&
            Lampa.Select &&
            typeof Lampa.Select.show === 'function'
        ) {
            var items = players.map(function (p) {
                return {
                    title: p.name,
                    package: p.package
                };
            });

            // Пункт «Запомнить выбор»
            items.push({
                title: '💾 Запомнить выбранный плеер',
                remember: true
            });

            Lampa.Select.show({
                title: 'Выберите плеер',
                items: items,
                onSelect: function (item) {
                    if (item.remember) {
                        // Возвращаемся к выбору без запоминания
                        showPlayerPicker(players, mediaUrl, title);
                        return;
                    }

                    if (item.package) {
                        openInPackage(mediaUrl, title, item.package, false);
                    }

                    Lampa.Controller.toggle('content');
                },
                onBack: function () {
                    Lampa.Controller.toggle('content');
                }
            });

            return;
        }

        // Fallback: простой список через prompt
        var names = players.map(function (p, i) {
            return (i + 1) + ') ' + p.name + ' — ' + p.package;
        }).join('\n');

        var answer = window.prompt(
            'Выберите плеер (введите номер):\n\n' + names,
            '1'
        );

        if (!answer) return;

        var index = parseInt(answer, 10) - 1;
        var chosen = players[index];

        if (!chosen) {
            notify('Плеер не выбран');
            return;
        }

        openInPackage(mediaUrl, title, chosen.package, false);
    }

    function openInPlayer(mediaUrl, title) {
        if (!mediaUrl) {
            notify('Нет прямой ссылки для видеоплеера');

            if (DEBUG) {
                console.log(
                    '[qBittorrent] streamUrl отсутствует. title:',
                    title
                );
            }

            return;
        }

        if (/^magnet:\?/i.test(mediaUrl)) {
            notify('Плеер не воспроизводит magnet. Сначала добавь торрент в qBittorrent');
            return;
        }

        if (!/^https?:\/\//i.test(mediaUrl)) {
            notify('Поддерживаются только http/https-ссылки');
            return;
        }

        var config = cfg();

        debugNotify('Открываю ссылку в плеере: ' + mediaUrl);

        // Если всегда спрашивать — показываем picker
        if (config.player_ask) {
            getInstalledPlayers(function (players) {
                showPlayerPicker(players, mediaUrl, title);
            });

            return;
        }

        // Если задан пакет — открываем сразу
        if (config.player_package) {
            var opened = openInPackage(
                mediaUrl,
                title,
                config.player_package,
                false
            );

            if (!opened) {
                notify('Android-мост плеера недоступен в этой сборке Lampa');
            }

            return;
        }

        // Пакет не задан, спрашивать выключено — показываем picker
        getInstalledPlayers(function (players) {
            showPlayerPicker(players, mediaUrl, title);
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

    // ================= ЭКРАН ВЫБОРА ПЛЕЕРА ДЛЯ НАСТРОЕК =================

    function showSettingsPlayerPicker() {
        getInstalledPlayers(function (players) {
            if (!players || !players.length) {
                notify('Установленные плееры не найдены');
                return;
            }

            if (
                window.Lampa &&
                Lampa.Select &&
                typeof Lampa.Select.show === 'function'
            ) {
                var items = players.map(function (p) {
                    return {
                        title: p.name,
                        package: p.package
                    };
                });

                items.push({
                    title: '❌ Сбросить (спрашивать каждый раз)',
                    reset: true
                });

                Lampa.Select.show({
                    title: 'Плеер по умолчанию',
                    items: items,
                    onSelect: function (item) {
                        if (item.reset) {
                            storeSet('qbit_player_package', '');
                            storeSet('qbit_player_ask', true);
                            notify('Плеер по умолчанию сброшен');
                        } else if (item.package) {
                            storeSet('qbit_player_package', item.package);
                            storeSet('qbit_player_ask', false);
                            notify(
                                'Плеер по умолчанию: ' +
                                item.title
                            );
                        }

                        Lampa.Controller.toggle('settings_component');
                    },
                    onBack: function () {
                        Lampa.Controller.toggle('settings_component');
                    }
                });

                return;
            }

            // Fallback
            var names = players.map(function (p, i) {
                return (i + 1) + ') ' + p.name + ' — ' + p.package;
            }).join('\n');

            var answer = window.prompt(
                'Выберите плеер по умолчанию (0 — сбросить):\n\n' +
                    names,
                '1'
            );

            if (answer === null) return;

            var num = parseInt(answer, 10);

            if (num === 0) {
                storeSet('qbit_player_package', '');
                storeSet('qbit_player_ask', true);
                notify('Плеер по умолчанию сброшен');
                return;
            }

            var chosen = players[num - 1];

            if (!chosen) {
                notify('Плеер не выбран');
                return;
            }

            storeSet('qbit_player_package', chosen.package);
            storeSet('qbit_player_ask', false);
            notify('Плеер по умолчанию: ' + chosen.name);
        });
    }

    // ================= РЕГИСТРАЦИЯ НАСТРОЕК =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) {
                console.error('[qBittorrent] Lampa.SettingsApi недоступен');
                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_url',
                    type: 'input',
                    values: '',
                    default: DEF_URL
                },
                field: {
                    name: 'Адрес сервера',
                    description: 'Адрес Web UI qBittorrent, например http://192.168.1.50:8080'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_user',
                    type: 'input',
                    values: '',
                    default: DEF_USER
                },
                field: {
                    name: 'Логин',
                    description: 'Логин, если не используется обход аутентификации'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_pass',
                    type: 'input',
                    values: '',
                    default: DEF_PASS
                },
                field: {
                    name: 'Пароль',
                    description: 'Пароль, если не используется обход аутентификации'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_bypass',
                    type: 'trigger',
                    default: DEF_BYPASS
                },
                field: {
                    name: 'Обход аутентификации',
                    description: 'Включи обход аутентификации для локальной сети в qBittorrent'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_savepath',
                    type: 'input',
                    values: '',
                    default: DEF_SAVEPATH
                },
                field: {
                    name: 'Базовый путь сохранения',
                    description: 'Например: /app/qBittorrent. Пусто = путь qBittorrent по умолчанию'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_category',
                    type: 'input',
                    values: '',
                    default: DEF_CATEGORY
                },
                field: {
                    name: 'Категория',
                    description: 'Категория для торрентов, например video'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_auto_cat_path',
                    type: 'trigger',
                    default: DEF_AUTO_CAT_PATH
                },
                field: {
                    name: 'Добавлять категорию к пути',
                    description: 'Например: /app/qBittorrent + video = /app/qBittorrent/video'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_rename',
                    type: 'trigger',
                    default: DEF_RENAME
                },
                field: {
                    name: 'Переименовывать торрент',
                    description: 'Использовать название раздачи как имя торрента'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_confirm',
                    type: 'trigger',
                    default: DEF_CONFIRM
                },
                field: {
                    name: 'Проверять добавление',
                    description: 'Проверять, появился ли торрент в qBittorrent'
                }
            });

            // --- Плеер по умолчанию ---

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_player_package',
                    type: 'input',
                    values: '',
                    default: DEF_PLAYER_PACKAGE
                },
                field: {
                    name: 'Плеер по умолчанию (пакет)',
                    description:
                        'Пакет плеера. Пусто = системный выбор. ' +
                        'Можно ввести вручную или выбрать из установленных ' +
                        'кнопкой «Выбрать из установленных»'
                }
            });

            // Кнопка «Выбрать из установленных» — через статический пункт
            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_player_pick',
                    type: 'static',
                    default: ''
                },
                field: {
                    name: 'Выбрать плеер из установленных',
                    description:
                        'Открывает список установленных на устройстве плееров ' +
                        'и сохраняет выбор как плеер по умолчанию'
                },
                onChange: function () {
                    showSettingsPlayerPicker();
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_player_reset',
                    type: 'static',
                    default: ''
                },
                field: {
                    name: 'Сбросить плеер по умолчанию',
                    description:
                        'Очищает сохранённый пакет и включает «Всегда спрашивать плеер»'
                },
                onChange: function () {
                    storeSet('qbit_player_package', '');
                    storeSet('qbit_player_ask', true);
                    notify('Плеер по умолчанию сброшен');
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_player_ask',
                    type: 'trigger',
                    default: DEF_PLAYER_ASK
                },
                field: {
                    name: 'Всегда спрашивать плеер',
                    description:
                        'Открывать выбор установленных плееров при каждом нажатии ' +
                        'кнопки «Плеер» (игнорирует плеер по умолчанию)'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_delete_files',
                    type: 'trigger',
                    default: DEF_DELETE_FILES
                },
                field: {
                    name: 'Удалять файлы торрента',
                    description: 'При удалении также удалять скачанные файлы на сервере'
                }
            });

            console.log('[qBittorrent] Настройки зарегистрированы');
        } catch (error) {
            console.error('[qBittorrent] Ошибка регистрации настроек:', error);
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
                console.error('[qBittorrent] Lampa.Menu.addButton недоступен');
                return;
            }

            var icon =
                '<svg viewBox="0 0 24 24" width="24" height="24">' +
                '<path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');

                setTimeout(function () {
                    var item = document.querySelector(
                        '[data-component="qbit_direct"]'
                    );

                    if (item) item.click();
                }, 100);
            });

            console.log('[qBittorrent] Пункт меню добавлен');
        } catch (error) {
            console.error('[qBittorrent] Ошибка добавления пункта меню:', error);
        }
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

    function getStreamUrl(data) {
        return (
            data.url ||
            data.Url ||
            data.stream_url ||
            data.StreamUrl ||
            data.file ||
            data.File ||
            ''
        );
    }

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;

        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render' || !event.item) return;

            var item = event.item.jquery ? event.item[
