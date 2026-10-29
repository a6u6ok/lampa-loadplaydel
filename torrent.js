// ============================================================================
// Плагин qBittorrent для Lampa.
// Сделан на основе плагина: https://github.com/kostya4000/lampa-qbit
// Автор оригинала: kostya4000
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
    var DEF_PLAYER_PACKAGE = '';
    var DEF_SMB_FILE = 'smb://192.168.1.50/download/';
    var DEF_ALWAYS_SHOW = true;

    var DEBUG = false;
    var ACTION_LOCK_MS = 1200;
    var CONFIRM_ATTEMPTS = 6;
    var CONFIRM_DELAY_MS = 1500;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

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

    // ================= СОСТОЯНИЕ =================

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
            console.error('[qBittorrent] storeSet error:', error);
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
            delete_files: isTrue(
                storeGet('qbit_delete_files', DEF_DELETE_FILES),
                DEF_DELETE_FILES
            ),
            player_package: storeGet('qbit_player_package', DEF_PLAYER_PACKAGE),
            smb_file: storeGet('qbit_smb_file', DEF_SMB_FILE),
            always_show: isTrue(
                storeGet('qbit_always_show', DEF_ALWAYS_SHOW),
                DEF_ALWAYS_SHOW
            )
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    function joinPath(basePath, subPath) {
        if (!basePath) return subPath || '';
        if (!subPath) return basePath;

        return String(basePath).replace(/\/+$/, '') + '/' +
               String(subPath).replace(/^\/+/, '');
    }

    function magnetHash(magnet) {
        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(magnet || '');

        return match ? match[1].toLowerCase() : '';
    }

    function encodePathSegments(path) {
        return String(path || '')
            .split('/')
            .filter(function (part) {
                return part !== '';
            })
            .map(function (part) {
                return encodeURIComponent(part);
            })
            .join('/');
    }

    function isVideoFile(name) {
        return /\.(mp4|mkv|avi|mov|m4v|ts|webm|wmv|flv|mpg|mpeg|vob|3gp)$/i.test(name || '');
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
        }).then(function () {
            debugNotify('Запрос отправлен в no-cors режиме');
        }).catch(function (error) {
            console.error('[qBittorrent] blind request error:', error);
            notify('Ошибка отправки запроса в qBittorrent');
        });
    }

    // ================= АВТОРИЗАЦИЯ =================

    function apiHeaders() {
        var headers = {
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        if (QBIT_SID) {
            headers.Cookie = 'SID=' + QBIT_SID;
        }

        return headers;
    }

    function sidIsValid() {
        return QBIT_SID && (Date.now() - QBIT_SID_TIME) < SID_LIFETIME_MS;
    }

    function qbLogin(callback) {
        var config = cfg();

        if (!config.user) {
            callback(false);
            return;
        }

        var body =
            'username=' + encodeURIComponent(config.user) +
            '&password=' + encodeURIComponent(config.pass);

        nativeRequest({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body: body,
            headers: CT_FORM
        }, function (response) {
            var ok = !!response && /Ok/i.test(response);

            if (ok) {
                try {
                    var raw = AndroidJS.getResp();
                    var match = /SID=([^;\s"']+)/i.exec(String(raw));

                    if (match) {
                        QBIT_SID = match[1];
                        QBIT_SID_TIME = Date.now();
                    }
                } catch (error) {
                    console.warn('[qBittorrent] Не удалось извлечь SID:', error);
                }
            }

            callback(ok);
        });
    }

    function ensureAuth(callback) {
        var config = cfg();

        if (config.bypass || !config.user)
