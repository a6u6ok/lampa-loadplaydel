// ============================================================================
// qBittorrent для Lampa — Keenetic + Entware + SMB
// Управление отдельными файлами внутри торрента
// ИСПРАВЛЕНО: убрана белая рамка при выделении кнопок, сброс стилей
// ============================================================================

(function () {
    'use strict';

    /* ---------- Константы ---------- */

    var EXAMPLE_URL = 'http://192.168.1.1:9080';
    var EXAMPLE_SAVEPATH = '/mnt/storage/torrents';
    var EXAMPLE_SMB = 'smb://192.168.1.1/MEDIA/';
    var DEFAULT_PACKAGE = 'top.rootu.dddplayer';

    var DEBUG = false;
    var LOCK_MS = 800;          // антидребезг нажатий
    var POLL_MS = 3000;         // опрос прогресса
    var VERIFY_MS = 1000;       // пауза между проверками добавления
    var VERIFY_N = 8;           // число проверок добавления
    var FILES_RETRY_MS = 1500;  // пауза между попытками получить список файлов
    var FILES_RETRY_N = 7;

    var reqId = 0, sid = '', loggedIn = false;
    var modalHash = '', modalReq = 0;

    var CT = { 'Content-Type': 'application/x-www-form-urlencoded' };

    var VIDEO = [
        'mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'mpg', 'mpeg',
        'ts', 'm2ts', 'webm', 'flv', 'vob', 'ogv', '3gp'
    ];

    var TEXT_FIELDS = [
        'qbit_url', 'qbit_user', 'qbit_pass', 'qbit_savepath',
        'qbit_category', 'qbit_smb_file', 'qbit_player_package'
    ];

    var SVG_STAR = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    var SVG_DOWN = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
    var SVG_PLAY = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
    var SVG_DEL = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

    /* ---------- Логи и уведомления ---------- */

    function log() {
        if (DEBUG) console.log.apply(
            console, ['[qBittorrent]'].concat(.slice.call(arguments))
        );
    }

    function notify(msg) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(String(msg));
                return;
            }
        } catch (e) {}
        console.log('[qBittorrent]', msg);
    }

    function debugNotify(msg) { if (DEBUG) notify(msg); }

    window.addEventListener('error', function (e) {
        console.error('[qBittorrent] SCRIPT ERROR:', e.message, 'строка:', e.lineno, e.error);
    });
    window.addEventListener('unhandledrejection', function (e) {
        console.error('[qBittorrent] PROMISE ERROR:', e.reason);
    });

    /* ---------- Хранилище ---------- */

    function storeGet(key, def) {
        try {
            var v = Lampa.Storage.get(key, def);
            return (v === undefined || v === null || v === '') ? def : v;
        } catch (e) { return def; }
    }

    function storeSet(key, value) {
        try { Lampa.Storage.set(key, value); } catch (e) {}
    }

    function isTrue(v, def) {
        return v === true || v === 'true' ? true :
               v === false || v === 'false' ? false : def;
    }

    function cfg() {
        return {
            url: String(storeGet('qbit_url', '') || '').trim(),
            user: String(storeGet('qbit_user', '') || '').trim(),
            pass: String(storeGet('qbit_pass', '') || '').trim(),
            bypass: isTrue(storeGet('qbit_bypass', true), true),
            savepath: String(storeGet('qbit_savepath', '') || '').trim(),
            category: String(storeGet('qbit_category', '') || '').trim(),
            rename: isTrue(storeGet('qbit_rename', true), true),
            confirm: isTrue(storeGet('qbit_confirm', true), true),
            delFiles: isTrue(storeGet('qbit_delete_files', false), false),
            extPlayer: isTrue(storeGet('qbit_external_player', true), true),
            smb: String(storeGet('qbit_smb_file', '') || '').trim()
        };
    }

    function configured() {
        var c = cfg();
        return !!(c.url && c.savepath && c.smb);
    }

    function requireSetup() {
        if (configured()) return true;
        notify('Сначала настройте qBittorrent');
        openWizard();
        return false;
    }

    function base() { return cfg().url.replace(/\/+\$/, ''); }

    /* ---------- Пути и файлы ---------- */

    function cleanPath(p) {
        return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+\$/, '');
    }

    function smbEncode(p) {
        return String(p || '').replace(/\\/g, '/').split('/')
            .filter(function (s) { return s !== ''; })
            .map(encodeURIComponent).join('/');
    }

    function basename(p) {
        return String(p || '').replace(/\\/g, '/').split('/').pop();
    }

    function isVideo(name) {
        var m = /\.([^.\/\\]+)\$/.exec(String(name || '').toLowerCase());
        return !!(m && VIDEO.indexOf(m) !== -1);
    }

    function fmtSize(b) {
        b = Number(b) || 0;
        if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
        if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
        return b + ' B';
    }

    function esc(v) {
        return String(v === undefined ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* ---------- Серии ---------- */

    var EP_PATTERNS = [
        /S(\d{1,2})E(\d{1,3})/i,
        /(?:^|\D)(\d{1,2})x(\d{1,3})(?!\d)/i, // не ловим "1920x1080"
        /Season[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})/i,
        /Сезон[\s._-]*(\d{1,2})[\s._-]*Серия[\s._-]*(\d{1,3})/i,
        /(\d{1,2})\s*сезон[\s._-]*(\d{1,3})\s*серия/i
    ];

    function episodeInfo(name) {
        var n = basename(name);
        for (var i = 0; i < EP_PATTERNS.length; i++) {
            var m = EP_PATTERNS[i].exec(n);
            if (m) return { season: +m, episode: +m, found: true };
        }
        return { season: 0, episode: 0, found: false };
    }

    function cmpFiles(a, b) {
        var ea = episodeInfo(a.name), eb = episodeInfo(b.name);
        if (ea.found !== eb.found) return ea.found ? -1 : 1;
        if (ea.found && ea.season !== eb.season) return ea.season - eb.season;
        if (ea.found && ea.episode !== eb.episode) return ea.episode - eb.episode;
        return String(a.name).localeCompare(String(b.name), undefined, {
            numeric: true, sensitivity: 'base'
        });
    }

    /* ---------- Magnet и hash ---------- */

    function magnetHash(v) {
        v = String(v || '').trim();
        var m = /urn:btih:([a-zA-Z0-9]+)/i.exec(v);
        if (m) return m.toLowerCase();
        return /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(v) ? v.toLowerCase() : '';
    }

    function extractMagnet(d) {
        if (typeof d === 'string') return /^magnet:\?/i.test(d) ? d : '';
        if (typeof d !== 'object' || !d) return '';
        var fields = ['MagnetUri', 'magnetUri', 'magnet_uri', 'magnet', 'Magnet',
            'url', 'torrent_url', 'torrentUrl', 'link'];
        for (var i = 0; i < fields.length; i++) {
            var v = d[fields[i]];
            if (typeof v === 'string' && /^magnet:\?/i.test(v)) return v;
        }
        return '';
    }

    function extractHash(d, depth) {
        depth = depth || 0;
        if (!d || typeof d !== 'object' || depth > 5) return '';

        var fields = ['hash', 'Hash', 'infohash', 'infoHash', 'InfoHash',
            'infohash_v1', 'infoHashV1', 'btih'];
        for (var i = 0; i < fields.length; i++) {
            if (d[fields[i]]) {
                var h = magnetHash(d[fields[i]]);
                if (h) return h;
            }
        }

        var magnet = extractMagnet(d);
        if (magnet && magnetHash(magnet)) return magnetHash(magnet);

        var nested = ['torrent', 'item', 'data', 'element', 'source', 'model', 'card'];
        for (var j = 0; j < nested.length; j++) {
            if (d[nested[j]]) {
                var r = extractHash(d[nested[j]], depth + 1);
                if (r) return r;
            }
        }
        return '';
    }

    /* ---------- HTTP ---------- */

    function normResponse(r) {
        if (r === null || r === undefined) return null;
        if (typeof r === 'string') return r;
        if (typeof r === 'object') {
            if (typeof r.responseText === 'string') return r.responseText;
            if (typeof r.response === 'string') return r.response;
            if (typeof r.body === 'string') return r.body;
            if (typeof r.data === 'string') return r.data;
            try { return JSON.stringify(r); } catch (e) { return null; }
        }
        return String(r);
    }

    function fetchHttp(request, cb) {
        if (typeof fetch !== 'function') return cb(null);
        var opts = {
            method: request.method || 'GET',
            headers: request.headers || CT,
            credentials: 'include'
        };
        if (request.body != null) opts.body = request.body;

        fetch(request.url, opts)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(cb, function (e) {
                console.error('[qBittorrent] fetch:', e);
                cb(null);
            });
    }

    function nativeHttp(request, cb) {
        if (!window.AndroidJS ||
            typeof window.AndroidJS.httpReq !== 'function' ||
            typeof window.AndroidJS.getResp !== 'function') {
            return fetchHttp(request, cb);
        }

        var id = ++reqId, done = false, start = Date.now(), tries = 0;
        var emptyOk = Number(request.emptySuccessAfter) || 0;
        var payload = { url: request.url, timeout: 20000, headers: request.headers || {} };
        if (request.body != null) payload.post_data = String(request.body);

        function finish(r) {
            if (!done) { done = true; cb(normResponse(r)); }
        }

        try { window.AndroidJS.httpReq(JSON.stringify(payload), id); }
        catch (e) {
            console.error('[qBittorrent] httpReq:', e);
            return fetchHttp(request, cb);
        }

        (function poll() {
            if (done) return;
            var r = null;
            try { r = window.AndroidJS.getResp(String(id)); } catch (e) {}
            var text = (r !== null && r !== undefined) ? normResponse(r) : null;

            if (text && text.length) return finish(text);
            if (emptyOk && Date.now() - start >= emptyOk) return finish(text || '');
            if (++tries >= 133) return finish(null);
            setTimeout(poll, 150);
        })();
    }

    /* ---------- Авторизация ---------- */

    function authHeaders() {
        var h = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (sid) h.Cookie = 'SID=' + sid;
        return h;
    }

    function doLogin(cb) {
        var c = cfg();
        if (c.bypass || !c.user) { loggedIn = true; return cb(true); }

        nativeHttp({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body: 'username=' + encodeURIComponent(c.user) +
                  '&password=' + encodeURIComponent(c.pass),
            headers: CT
        }, function (resp) {
            if (!resp || /Forbidden|403|Fails/i.test(resp) ||
                !/^Ok\./i.test(String(resp).trim())) {
                loggedIn = false;
                notify('Ошибка авторизации qBittorrent');
                return cb(false);
            }
            var m = /SID=([^;\s]+)/i.exec(String(resp));
            if (m) sid = m;
            else log('SID не получен из ответа — проверьте обход аутентификации');
            loggedIn = true;
            cb(true);
        });
    }

    function qbRequest(request, cb, retry) {
        var c = cfg();
        if (c.bypass || !c.user) return nativeHttp(request, cb);

        function send() {
            request.headers = authHeaders();
            nativeHttp(request, function (resp) {
                var expired = resp === null || /Forbidden|403/i.test(String(resp));
                if (expired && !retry) {
                    loggedIn = false;
                    sid = '';
                    return qbRequest(request, cb, true);
                }
                cb(resp);
            });
        }

        if (!loggedIn) return doLogin(function (ok) { ok ? send() : cb(null); });
        send();
    }

    function qbGet(path, cb) {
        qbRequest({ url: base() + path, method: 'GET', headers: authHeaders() }, cb);
    }

    function qbPost(path, body, cb) {
        qbRequest({ url: base() + path, method: 'POST', body: body, headers: authHeaders() }, cb);
    }

    /* ---------- Добавление, удаление, прогресс ---------- */

    function parseTorrents(resp) {
        if (typeof resp !== 'string' || !resp.trim()) return null;
        try {
            var d = JSON.parse(resp);
            if (Array.isArray(d)) return d;
            if (d && Array.isArray(d.torrents)) return d.torrents;
        } catch (e) {
            log('Ошибка разбора torrents/info:', e);
        }
        return null;
    }

    function addBody(magnet, title) {
        var c = cfg();
        var p = [
            'urls=' + encodeURIComponent(magnet),
            'savepath=' + encodeURIComponent(cleanPath(c.savepath)),
            'autoTMM=false', 'contentLayout=NoSubfolder',
            'paused=false', 'sequentialDownload=false'
        ];
        if (c.category) p.push('category=' + encodeURIComponent(c.category));
        if (c.rename && title) p.push('rename=' + encodeURIComponent(title));
        return p.join('&');
    }

    function torrentProgress(hash, cb) {
        if (!hash) return cb(null);
        qbGet('/api/v2/torrents/info?hashes=' + encodeURIComponent(hash), function (resp) {
            var t = parseTorrents(resp);
            cb(t && t.length ? Number(t.progress) || 0 : null);
        });
    }

    function verifyAdded(hash, attempt, cb) {
        attempt = attempt || 0;
        if (!hash) return cb(false);
        torrentProgress(hash, function (p) {
            if (p !== null) return cb(true);
            if (attempt + 1 >= VERIFY_N) return cb(false);
            setTimeout(function () { verifyAdded(hash, attempt + 1, cb); }, VERIFY_MS);
        });
    }

    function qbAdd(magnet, title, cb) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Не удалось получить magnet-ссылку');
            return cb && cb(false);
        }

        debugNotify('Отправляю в qBittorrent...');

        qbPost('/api/v2/torrents/add', addBody(magnet, title), function (resp) {
            if (resp == null) {
                notify('Нет связи с qBittorrent');
                return cb && cb(false);
            }
            if (/Forbidden|403|Errored/i.test(resp)) {
                notify('Ошибка добавления: ' + resp);
                return cb && cb(false);
            }
            if (!cfg().confirm) {
                notify('Отправлено в qBittorrent');
                return cb && cb(true);
            }
            verifyAdded(magnetHash(magnet), 0, function (found) {
                notify(found ?
                    'Торрент успешно добавлен' :
                    'Запрос отправлен. Проверьте список торрентов.');
                cb && cb(true, found);
            });
        });
    }

    function qbDelete(hashOrMagnet, cb) {
        var hash = magnetHash(hashOrMagnet);
        if (!hash) {
            notify('Не удалось определить хеш торрента');
            return cb && cb(false);
        }

        qbRequest({
            url: base() + '/api/v2/torrents/delete',
            method: 'POST',
            body: 'hashes=' + encodeURIComponent(hash) +
                  '&deleteFiles=' + (cfg().delFiles ? 'true' : 'false'),
            headers: authHeaders(),
            emptySuccessAfter: 1500
        }, function (resp) {
            if (resp == null) {
                notify('Нет связи с qBittorrent');
                return cb && cb(false);
            }
            if (/Forbidden|403|Fails/i.test(String(resp))) {
                notify('Ошибка удаления торрента');
                return cb && cb(false);
            }
            notify(cfg().delFiles ?
                'Торрент и его файлы отправлены на удаление' :
                'Торрент отправлен на удаление');
            cb && cb(true);
        });
    }

    /* ---------- SMB и плеер ---------- */

    function smbUri(name) {
        var root = cfg().smb.replace(/\\/g, '/').replace(/\/+\$/, '');
        if (!/^smb:\/\//i.test(root)) {
            notify('Укажите корректный корень SMB в настройках qBittorrent');
            return '';
        }
        var file = cleanPath(name).replace(/^\/+/, '');
        return root + (file ? '/' + smbEncode(file) : '');
    }

    function openPlayer(uri, title) {
        uri = String(uri || '').trim();
        if (!uri) return notify('Не указан путь к видеофайлу');

        var m = /\.([^.\/?#]+)(?:[?#]|\$)/i.exec(uri);
        var data = {
            url: uri,
            title: title || 'qBittorrent',
            source: 'qBittorrent',
            quality: 'auto',
            exe: m ? '.' + m.toLowerCase() : ''
        };

        if (cfg().extPlayer) {
            if (window.AndroidJS && typeof window.AndroidJS.openPlayer === 'function') {
                try { return window.AndroidJS.openPlayer(uri, JSON.stringify(data)); }
                catch (e) {
                    console.error('[qBittorrent] openPlayer:', e);
                    return notify('Ошибка запуска видео');
                }
            }
            return notify('AndroidJS.openPlayer недоступен');
        }

        try {
            if (window.Lampa && Lampa.Player && typeof Lampa.Player.play === 'function')
                return Lampa.Player.play(data);
        } catch (e) { console.error('[qBittorrent] Lampa.Player:', e); }
        notify('Не удалось запустить плеер Lampa');
    }

    function playFile(file) {
        if (!file) return notify('Файл не выбран');

        var p = Number(file.progress);
        if (!isFinite(p) || p < 0.999999)
            return notify('Этот файл ещё не загружен полностью');
        if (!isVideo(file.name))
            return notify('Выбранный файл не является видео');

        var uri = smbUri(file.name);
        log('Запуск файла:', file.name, 'Размер:', fmtSize(file.size), 'SMB:', uri);
        openPlayer(uri, basename(file.name));
    }

    /* ---------- Информация и файлы торрента ---------- */

    function torrentInfo(hash, cb) {
        var target = String(hash || '').trim().toLowerCase();
        if (!target) return cb && cb(null);

        function match(t) {
            return !!t && [t.hash, t.infohash_v1, t.infohash_v2].some(function (v) {
                return String(v || '').trim().toLowerCase() === target;
            });
        }

        qbGet('/api/v2/torrents/info?hashes=' + encodeURIComponent(target), function (resp) {
            var list = parseTorrents(resp);
            if (list && list.length) {
                var exact = list.filter(match);
                if (exact) return cb(exact);
            }
            qbGet('/api/v2/torrents/info', function (all) {
                var found = (parseTorrents(all) || ).filter(match) || null;
                if (!found) log('Торрент не найден по хешу:', target);
                cb(found);
            });
        });
    }

    function torrentFiles(hash, attempt, cb) {
        attempt = attempt || 0;
        qbGet('/api/v2/torrents/files?hash=' + encodeURIComponent(hash), function (resp) {
            var files = ;
            try {
                if (typeof resp === 'string' && resp.length) files = JSON.parse(resp);
            } catch (e) {
                console.error('[qBittorrent] Ошибка разбора списка файлов:', resp, e);
            }
            if (Array.isArray(files) && files.length) {
                log('Получено файлов:', files.length);
                return cb(files);
            }
            log('Список файлов пуст. Попытка:', attempt + 1, 'Хеш:', hash, 'Ответ:', resp);
            if (attempt >= FILES_RETRY_N) return cb();
            setTimeout(function () { torrentFiles(hash, attempt + 1, cb); }, FILES_RETRY_MS);
        });
    }

    /* ---------- Окно файлов ---------- */

    function fileIndex(f) {
        if (!f) return null;
        if (f.index !== undefined && f.index !== null && f.index !== '') return f.index;
        if (f.id !== undefined && f.id !== null && f.id !== '') return f.id;
        return null;
    }

    function findFile(files, id) {
        if (!Array.isArray(files) || id == null || id === '') return null;
        for (var i = 0; i < files.length; i++) {
            var cur = fileIndex(files[i]);
            if (cur !== null && String(cur) === String(id)) return files[i];
        }
        return null;
    }

    function centerFocus(el, box) {
        if (!el || !box) return;
        var row = el.closest ? el.closest('.qbit-file') : null;
        if (!row) return;

        var outer = box.getBoundingClientRect();
        var inner = row.getBoundingClientRect();
        if (!inner.height || !outer.height) return;

        var target = box.scrollTop +
            (inner.top - outer.top) +
            (inner.height / 2) -
            (outer.height / 2);

        var max = box.scrollHeight - outer.height;
        box.scrollTop = Math.max(0, Math.min(max, target));
    }

    function focusFirst(list) {
        setTimeout(function () {
            var sel = '.qbit-file__button.selector:not(:disabled), .qbit-files__refresh.selector';
            var btn = list.querySelector(sel);
            if (!btn) return;

            try {
                btn.focus();
                centerFocus(btn, list);

                if (window.Lampa && Lampa.Controller &&
                    typeof Lampa.Controller.collectionFocus === 'function') {
                    Lampa.Controller.collectionFocus(false, sel);
                }
            } catch (e) { log('Не удалось установить фокус:', e); }
        }, 150);
    }

    function renderFiles(hash, torrent, files) {
        if (!window.Lampa || !Lampa.Modal) return notify('Окно файлов недоступно');
        if (!window.jQuery) return notify('Не удалось открыть список файлов: jQuery недоступен');

        var video = (files || ).filter(function (f) { return isVideo(f.name); }).sort(cmpFiles);
        if (!video.length) return notify('В торренте нет видеофайлов');

        var done = video.filter(function (f) {
            return Number(f.progress) >= 0.999999;
        }).length;

        // --- ИСПРАВЛЕНИЕ СТИЛЕЙ: Убираем белую рамку и сброс стилей ---
        var style = document.createElement('style');
        style.innerHTML = `
            .qbit-files .qbit-file__button {
                background: #2c2c2c;
                color: #fff;
                border: 1px solid #444;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.2s ease;
                outline: none !important; /* ГЛАВНОЕ: Убирает белую рамку браузера */
            }
            .qbit-files .qbit-file__button:hover,
            .qbit-files .qbit-file__button:focus {
                background: #444;
                border-color: #666;
                color: #fff;
                outline: none !important; /* Гарантируем отсутствие рамки */
            }
            .qbit-files .qbit-file__button.qbit-file__play--ready {
                background: #007bff;
                border-color: #0056b3;
            }
            .qbit-files .qbit-file__button.qbit-file__play--ready:hover,
            .qbit-files .qbit-file__button.qbit-file__play--ready:focus {
                background: #0056b3;
                border-color: #004085;
                color: #fff;
                outline: none !important;
            }
            .qbit-files .qbit-file__button:disabled {
                background: #333;
                color: #666;
                border-color: #333;
                cursor: not-allowed;
                outline: none !important;
            }
            .qbit-files__list {
                max-height: 60vh;
                overflow-y: auto;
                padding-right: 10px;
            }
            .qbit-file {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 12px;
                border-bottom: 1px solid #333;
                background: #1a1a1a;
            }
            .qbit-file:last-child { border-bottom: none; }
            .qbit-file__info { flex: 1; margin-right: 15px; }
            .qbit-file__name { font-weight: 600; color: #fff; margin-bottom: 4px; }
            .qbit-file__episode { color: #aaa; font-size: 13px; margin-bottom: 4px; }
            .qbit-file__meta { color: #888; font-size: 12px; margin-bottom: 6px; }
            .qbit-file__progress { height: 4px; background: #333; border-radius: 2px; overflow: hidden; }
            .qbit-file__progress div { height: 100%; background: #007bff; }
        `;
        document.head.appendChild(style);
        // ---------------------------------------------------------------

        var html =
            '<div class="qbit-files">' +
                '<div class="qbit-files__header">' +
                    '<div class="qbit-files__torrent">' + esc(torrent && torrent.name || 'Торрент') + '</div>' +
                    '<div class="qbit-files__summary">Видео: ' + video.length + ' · Загружено: ' + done + '</div>' +
                    '<div class="qbit-files__hint">Выберите файл для воспроизведения</div>' +
                '</div>' +
                '<div class="qbit-files__list">';

        video.forEach(function (f) {
            var pct = Math.max(0, Math.min(100, Math.floor((Number(f.progress) || 0) * 100)));
            var ready = pct >= 100;
            var id = fileIndex(f);
            var idAttr = id === null ? '' : String(id);
            var ep = episodeInfo(f.name);

            html +=
                '<div class="qbit-file" data-file-id="' + esc(idAttr) + '">' +
                    '<div class="qbit-file__info">' +
                        '<div class="qbit-file__name">' + esc(basename(f.name)) + '</div>' +
                        (ep.found ?
                            '<div class="qbit-file__episode">Сезон ' + ep.season + ' · Серия ' + ep.episode + '</div>' : '') +
                        '<div class="qbit-file__meta">' + (ready ? 'Загружено' : 'Загрузка: ' + pct + '%') +
                            ' · ' + fmtSize(f.size) + '</div>' +
                        '<div class="qbit-file__progress"><div style="width:' + pct + '%"></div></div>' +
                    '</div>' +
                    '<div class="qbit-file__actions">' +
                        '<button type="button" class="qbit-file__button qbit-file__play selector' +
                        (ready ? ' qbit-file__play--ready' : '') + '" tabindex="0" data-action="play"' +
                        ' data-id="' + esc(idAttr) + '"' + (ready ? '' : ' disabled') + '>Смотреть</button>' +
                    '</div>' +
                '</div>';
        });

        html +=
                '</div>' +
                '<div class="qbit-files__footer">' +
                    '<button type="button" class="qbit-files__refresh selector" tabindex="0">Обновить список</button>' +
                '</div>' +
            '</div>';

        var el = document.createElement('div');
        el.innerHTML = html;

        if (modalHash === hash) { try { Lampa.Modal.close(); } catch (e) {} }
        modalHash = hash;

        Lampa.Modal.open({
            title: 'Файлы торрента',
            html: window.jQuery(el),
            size: 'large',
            align: 'top',
            mask: true,
            onBack: function () {
                modalHash = '';
                modalReq++;
                Lampa.Modal.close();
                Lampa.Controller.toggle('content');
            }
        });

        var list = el.querySelector('.qbit-files');
        focusFirst(list);

        window.jQuery(el)
            .find('[data-action="play"]').on('hover:enter click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var f = findFile(files, this.getAttribute('data-id'));
                if (!f) {
                    notify('Файл не найден в полученном списке qBittorrent');
                    return log('Не найден файл. Индекс:', this.getAttribute('data-id'));
                }
                playFile(f);
            }).end()
            .find('.qbit-files__refresh').on('hover:enter click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                refreshFiles(hash);
            }).end()
            .on('focusin hover:focus', '.selector', function () { centerFocus(this, list); });
    }

    function refreshFiles(hash) {
        var req = ++modalReq;
        torrentInfo(hash, function (t) {
            if (req !== modalReq) return;
            if (!t) return notify('Торрент не найден');
            torrentFiles(String(t.hash || hash).trim().toLowerCase(), 0, function (files) {
                if (req !== modalReq) return;
                if (!files || !files.length)
                    return notify('Не удалось обновить список файлов');
                renderFiles(hash, t, files);
            });
        });
    }

    /* ---------- Play в карточке ---------- */

    function openFiles(hash) {
        if (!hash) return notify('Не удалось определить хеш торрента');
        if (!requireSetup()) return;

        log('Открытие списка серий по кнопке Play. Хеш:', hash);
        debugNotify('Получаю список серий...');

        torrentInfo(hash, function (t) {
            if (!t) return notify('Торрент не найден в qBittorrent');
            var h = String(t.hash || hash).trim().toLowerCase();
            torrentFiles(h, 0, function (files) {
                if (!files || !files.length)
                    return notify('Не удалось получить список файлов торрента');
                if (!files.some(function (f) { return isVideo(f.name); }))
                    return notify('В торренте нет видеофайлов');
                renderFiles(h, t, files);
            });
        });
    }

    function bindPress(el, handler) {
        var last = 0;
        function wrap(e) {
            var now = Date.now();
            if (now - last < LOCK_MS) return;
            last = now;
            if (e) {
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            }
            handler(e);
        }
        if (window.jQuery) window.jQuery(el).on('hover:enter click', wrap);
        else el.addEventListener('click', wrap);
    }

    /* ---------- Кнопки карточки и прогресс ---------- */

    function setProgress(btn, p, icon) {
        if (!btn) return;
        btn.classList.remove('qbit-loading', 'qbit-done');
        if (p === null || p === undefined) {
            btn.innerHTML = icon + '<span class="qbit-btn-text">qB</span>';
        } else if (p >= 1) {
            btn.classList.add('qbit-done');
            btn.innerHTML = icon + '<span class="qbit-btn-text">Готов</span>';
        } else {
            btn.classList.add('qbit-loading');
            btn.innerHTML = icon +
                '<span class="qbit-btn-text">' + Math.max(0, Math.min(99, Math.floor(p * 100))) + '%</span>';
        }
    }

    function stopPoll(btn) {
        if (!btn) return;
        if (btn._qbitTimer) { clearInterval(btn._qbitTimer); btn._qbitTimer = null; }
        btn.dataset.qbitPolling = '0';
    }

    function startPoll(btn, hash, item, icon) {
        if (!btn || !hash || btn._qbitTimer) return;
        btn.dataset.qbitPolling = '1';
        btn._qbitTimer = setInterval(function () {
            try {
                if (!document.body.contains(item) || !document.body.contains(btn))
                    return stopPoll(btn);

                torrentProgress(hash, function (p) {
                    if (btn.dataset.qbitPolling !== '1') return;
                    if (!document.body.contains(btn)) return stopPoll(btn);
                    if (p === null) {
                        stopPoll(btn);
                        return setProgress(btn, null, icon);
                    }
                    if (p >= 1) {
                        stopPoll(btn);
                        setProgress(btn, 1, icon);
                        return notify('Загрузка завершена!');
                    }
                    setProgress(btn, p, icon);
                });
            } catch (e) {
                stopPoll(btn);
                console.error('[qBittorrent] polling:', e);
            }
        }, POLL_MS);
    }

    function restoreState(btn, hash, item, icon) {
        if (!btn || !hash) return;
        stopPoll(btn);
        torrentProgress(hash, function (p) {
            if (!document.body.contains(btn) || !document.body.contains(item)) return;
            setProgress(btn, p, icon);
            if (p !== null && p < 1) startPoll(btn, hash, item, icon);
        });
    }

    /* ---------- Мастер настройки ---------- */

    function openWizard() {
        if (!window.Lampa || !Lampa.Modal)
            return notify('Настройки: Настройки → qBittorrent');
        if (!window.jQuery)
            return notify('Не удалось открыть настройки: jQuery недоступен');

        var c = cfg();

        function field(id, label, value, example) {
            return '<div class="qbit-wizard__field">' +
                '<label>' + label + '</label>' +
                '<input type="text" id="' + id + '" value="' + esc(value) + '">' +
                '<div class="qbit-wizard__hint">Пример: ' + esc(example) + '</div>' +
                '</div>';
        }

        var el = document.createElement('div');
        el.className = 'qbit-wizard';
        el.innerHTML =
            '<div class="qbit-wizard__title">Настройки qBittorrent</div>' +
            field('qbit_url', 'URL API qBittorrent', c.url, EXAMPLE_URL) +
            field('qbit_user', 'Логин', c.user, 'admin') +
            field('qbit_pass', 'Пароль', c.pass, 'admin') +
            field('qbit_savepath', 'Путь сохранения (на диске)', c.savepath, EXAMPLE_SAVEPATH) +
            field('qbit_smb_file', 'SMB путь для плеера', c.smb, EXAMPLE_SMB) +
            field('qbit_category', 'Категория (опционально)', c.category, 'TV') +
            '<div class="qbit-wizard__actions">' +
                '<button type="button" class="qbit-wizard__save">Сохранить</button>' +
                '<button type="button" class="qbit-wizard__close">Отмена</button>' +
            '</div>';

        Lampa.Modal.open({
            title: 'qBittorrent',
            html: window.jQuery(el),
            size: 'small',
            align: 'center',
            mask: true,
            onBack: function () { Lampa.Modal.close(); }
        });

        window.jQuery(el).find('.qbit-wizard__save').on('click', function () {
            storeSet('qbit_url', window.jQuery('#qbit_url').val());
            storeSet('qbit_user', window.jQuery('#qbit_user').val());
            storeSet('qbit_pass', window.jQuery('#qbit_pass').val());
            storeSet('qbit_savepath', window.jQuery('#qbit_savepath').val());
            storeSet('qbit_smb_file', window.jQuery('#qbit_smb_file').val());
            storeSet('qbit_category', window.jQuery('#qbit_category').val());
            notify('Настройки сохранены');
            Lampa.Modal.close();
        });

        window.jQuery(el).find('.qbit-wizard__close').on('click', function () {
            Lampa.Modal.close();
        });
    }

    /* ---------- Инициализация плагина ---------- */

    function init() {
        log('Инициализация плагина qBittorrent...');
        
        // Проверка наличия Lampa
        if (!window.Lampa) {
            console.warn('[qBittorrent] Lampa не найдена, плагин не активен');
            return;
        }

        // Добавляем кнопку в карточку фильма/сериала
        // Ищем контейнер карточки (обычно это .card__info или .card__actions)
        // Используем MutationObserver для перехвата динамической загрузки карточек
        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                if (mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(function (node) {
                        if (node.nodeType === 1) {
                            var cards = node.querySelectorAll('.card__info, .card__actions');
                            cards.forEach(function (card) {
                                var hash = extractHash(card.dataset);
                                if (hash) {
                                    var btn = card.querySelector('.qbit-btn');
                                    if (!btn) {
                                        var btnHtml =
                                            '<button type="button" class="qbit-btn selector" tabindex="0">' +
                                            SVG_PLAY + '<span class="qbit-btn-text">qB</span></button>';
                                        var btnEl = document.createElement('div');
                                        btnEl.innerHTML = btnHtml;
                                        var target = card.querySelector('.card__actions') || card;
                                        target.appendChild(btnEl.firstChild);
                                        
                                        bindPress(btnEl.firstChild, function () {
                                            openFiles(hash);
                                        });
                                        
                                        restoreState(btnEl.firstChild, hash, card, SVG_PLAY);
                                    }
                                }
                            });
                        }
                    });
                }
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
        
        log('qBittorrent плагин активен');
    }

    // Запуск при загрузке скрипта
    init();

})();
