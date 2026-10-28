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

    // Список плееров: ключ — внутреннее имя, значение — label
    var PLAYER_OPTIONS = {
        'default': 'Системный (по умолчанию)',
        'mxplayer': 'MX Player',
        'vlc': 'VLC for Android',
        'kodi': 'Kodi',
        'localcast': 'LocalCast',
        'justplayer': 'Just Player'
    };

    var DEF_PLAYER = 'default';

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

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

    function isTrue(value, defaultValue) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;

        return defaultValue;
    }

    function cfg() {
        var playerRaw = storeGet('qbit_player', DEF_PLAYER);
        // Защита от невалидных значений
        if (!PLAYER_OPTIONS[playerRaw]) playerRaw = DEF_PLAYER;

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
            delete_files: isTrue(
                storeGet('qbit_delete_files', DEF_DELETE_FILES),
                DEF_DELETE_FILES
            ),
            player: playerRaw
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

    // ================= ЗАПУСК ПЛЕЕРА =================

    /**
     * Запускает файл в выбранном плеере.
     * @param {string} filePath — полный локальный путь к файлу.
     */
    function launchPlayer(filePath) {
        var config = cfg();
        var player = config.player || 'default';

        if (!filePath) {
            notify('Путь к файлу не определён');
            return;
        }

        // Нормализация пути: убираем лишние слэши
        var normalizedPath = String(filePath).replace(/\\/g, '/').replace(/\/+/g, '/');

        // Формируем file:// URI
        var fileUri = 'file://' + normalizedPath;

        var intent = {
            action: 'ACTION_VIEW',
            data: fileUri,
            type: 'video/*' // можно уточнить тип под конкретный контейнер
        };

        // Подбираем packageName/component в зависимости от плеера
        switch (player) {
            case 'mxplayer':
                intent.packageName = 'com.mxtech.videoplayer.ad';
                // intent.component = 'com.mxtech.videoplayer.ad.ActivityScreen';
                break;
            case 'vlc':
                intent.packageName = 'org.videolan.vlc';
                break;
            case 'kodi':
                intent.packageName = 'org.xbmc.kodi';
                break;
            case 'localcast':
                intent.packageName = 'com.localcast.tv';
                break;
            case 'justplayer':
                intent.packageName = 'com.justplayer';
                break;
            default:
                // Системный по умолчанию — без packageName
                delete intent.packageName;
                delete intent.component;
                break;
        }

        try {
            if (typeof AndroidJS !== 'undefined' && typeof AndroidJS.launchIntent === 'function') {
                AndroidJS.launchIntent(JSON.stringify(intent));
                debugNotify('Запущен плеер: ' + player + ', файл: ' + normalizedPath);
            } else {
                notify('AndroidJS.launchIntent недоступен — запуск плеера невозможен');
            }
        } catch (e) {
            console.error('[Player] launchIntent error:', e);
            notify('Ошибка запуска плеера');
        }
    }

    // Эвристика для получения «предполагаемого» пути к файлу.
    // В реальном сценарии путь лучше брать из источника/метаданных.
    function getFilePathFromItem(data) {
        var config = cfg();
        var savepath = config.savepath;
        var title = data.Title || data.
