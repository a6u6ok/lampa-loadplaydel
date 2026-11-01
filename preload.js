// ============================================================================
// qBittorrent для Lampa — Keenetic + Entware + SMB
// Управление отдельными файлами внутри торрента
// ============================================================================

(function () {
    'use strict';

    var EXAMPLE_URL = 'http://192.168.1.1:9080';
    var EXAMPLE_SAVEPATH = '/mnt/storage/torrents';
    var EXAMPLE_SMB = 'smb://192.168.1.1/MEDIA/';
    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;
    var FILE_RETRY_INTERVAL = 1500;
    var FILE_RETRY_ATTEMPTS = 8;

    var requestId = 0;
    var sid = '';
    var loggedIn = false;
    var CT_FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

    var VIDEO_EXTENSIONS = [
        'mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'mpg',
        'mpeg', 'ts', 'm2ts', 'webm', 'flv', 'vob', 'ogv', '3gp'
    ];

    function log() {
        if (DEBUG) console.log.apply(console, ['[qBittorrent]'].concat([].slice.call(arguments)));
    }

    function notify(message) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(String(message));
                return;
            }
        } catch (e) {}
        console.log('[qBittorrent]', message);
    }

    function storeGet(key, fallback) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var value = Lampa.Storage.get(key, fallback);
                if (value !== undefined && value !== null && value !== '') return value;
            }
        } catch (e) { log('Storage get:', e); }
        return fallback;
    }

    function storeSet(key, value) {
        try {
            if (window.Lampa && Lampa.Storage) Lampa.Storage.set(key, value);
        } catch (e) { log('Storage set:', e); }
    }

    function isTrue(value, fallback) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return fallback;
    }

    function cfg() {
        return {
            url: String(storeGet('qbit_url', '') || '').trim().replace(/\/+$/, ''),
            user: String(storeGet('qbit_user', '') || ''),
            pass: String(storeGet('qbit_pass', '') || ''),
            bypass: isTrue(storeGet('qbit_bypass', true), true),
            savepath: String(storeGet('qbit_savepath', '') || '').trim(),
            category: String(storeGet('qbit_category', '') || '').trim(),
            rename: isTrue(storeGet('qbit_rename', true), true),
            confirm: isTrue(storeGet('qbit_confirm', true), true),
            delete_files: isTrue(storeGet('qbit_delete_files', false), false),
            external_player: isTrue(storeGet('qbit_external_player', true), true),
            player_package: String(storeGet('qbit_player_package', 'top.rootu.dddplayer') || 'top.rootu.dddplayer').trim(),
            smb_file: String(storeGet('qbit_smb_file', '') || '').trim()
        };
    }

    function base() { return cfg().url; }

    function isConfigured() {
        var c = cfg();
        return !!(c.url && c.savepath && c.smb_file);
    }

    function requireSetup() {
        if (isConfigured()) return true;
        notify('Сначала настройте qBittorrent');
        openSetupWizard();
        return false;
    }

    function cleanPath(path) {
        return String(path || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    }

    function basename(path) {
        var parts = String(path || '').replace(/\\/g, '/').split('/');
        return parts[parts.length - 1] || '';
    }

    function encodePath(path) {
        return String(path || '').replace(/\\/g, '/').split('/')
            .filter(function (part) { return !!part; })
            .map(encodeURIComponent).join('/');
    }

    function makeSmbUri(fileName) {
        var root = String(cfg().smb_file || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
        // Добавление выполняется с contentLayout=NoSubfolder: файлы лежат прямо в savepath.
        // Поэтому исходные внутренние каталоги torrent file.name здесь отбрасываются.
        var file = basename(cleanPath(fileName));
        var uri = root + (file ? '/' + encodePath(file) : '');
        log('SMB URI:', uri);
        return uri;
    }

    function isVideoFile(name) {
        var match = /\.([^.\/\\]+)$/.exec(String(name || '').toLowerCase());
        return !!(match && VIDEO_EXTENSIONS.indexOf(match[1]) !== -1);
    }

    function formatSize(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
        if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return bytes + ' B';
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function magnetHash(value) {
        value = String(value || '').trim();
        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(value);
        if (match) return match[1].toLowerCase();
        if (/^[a-f0-9]{40}$/i.test(value) || /^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
        return '';
    }

    function extractMagnet(data) {
        if (typeof data === 'string') return /^magnet:\?/i.test(data) ? data : '';
        if (!data || typeof data !== 'object') return '';
        var keys = ['MagnetUri', 'magnetUri', 'magnet_uri', 'magnet', 'Magnet', 'url', 'torrent_url', 'torrentUrl', 'link'];
        for (var i = 0; i < keys.length; i++) {
            if (typeof data[keys[i]] === 'string' && /^magnet:\?/i.test(data[keys[i]])) return data[keys[i]];
        }
        return '';
    }

    function extractHash(data, depth) {
        depth = depth || 0;
        if (!data || depth > 5) return '';
        if (typeof data === 'string') return magnetHash(data);
        if (typeof data !== 'object') return '';
        var keys = ['hash', 'Hash', 'infohash', 'infoHash', 'InfoHash', 'infohash_v1', 'infoHashV1', 'btih'];
        for (var i = 0; i < keys.length; i++) {
            if (data[keys[i]]) {
                var h = magnetHash(data[keys[i]]);
                if (h) return h;
            }
        }
        var m = extractMagnet(data);
        if (m) return magnetHash(m);
        var nested = ['torrent', 'item', 'data', 'element', 'source', 'model', 'card'];
        for (var j = 0; j < nested.length; j++) {
            if (data[nested[j]]) {
                var found = extractHash(data[nested[j]], depth + 1);
                if (found) return found;
            }
        }
        return '';
    }

    function normalizeResponse(response) {
        if (response == null) return null;
        if (typeof response === 'string') return response;
        if (typeof response === 'object') {
            if (typeof response.responseText === 'string') return response.responseText;
            if (typeof response.response === 'string') return response.response;
            if (typeof response.body === 'string') return response.body;
            if (typeof response.data === 'string') return response.data;
            try { return JSON.stringify(response); } catch (e) { return null; }
        }
        return String(response);
    }

    function fetchRequest(request, callback) {
        if (typeof fetch !== 'function') { callback(null); return; }
        var options = {
            method: request.method || 'GET',
            headers: request.headers || CT_FORM,
            credentials: 'include'
        };
        if (request.body !== undefined && request.body !== null) options.body = request.body;
        fetch(request.url, options).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.text();
        }).then(callback).catch(function (error) {
            log('fetch error:', error);
            callback(null);
        });
    }

    function nativeRequest(request, callback) {
        var done = false;
        var id = ++requestId;
        var payload = { url: request.url, timeout: 20000, headers: request.headers || {} };
        if (request.body !== undefined && request.body !== null) payload.post_data = String(request.body);

        function finish(value) {
            if (done) return;
            done = true;
            callback(normalizeResponse(value));
        }

        function fallback() {
            if (done) return;
            done = true;
            log('Native HTTP timeout; fallback to fetch');
            fetchRequest(request, callback);
        }

        if (!window.AndroidJS ||
            typeof window.AndroidJS.httpReq !== 'function' ||
            typeof window.AndroidJS.getResp !== 'function') {
            fetchRequest(request, callback);
            return;
        }

        try {
            window.AndroidJS.httpReq(JSON.stringify(payload), id);
        } catch (e) {
            log('httpReq error:', e);
            fetchRequest(request, callback);
            return;
        }

        var tries = 0;
        (function poll() {
            if (done) return;
            tries++;
            var response = null;
            try { response = window.AndroidJS.getResp(String(id)); } catch (e) {}
            if (response !== null && response !== undefined) {
                var normalized = normalizeResponse(response);
                // Для JSON-массивов и строковых ответов ждём непустое тело.
                if (normalized !== null && normalized.length > 0) {
                    finish(normalized);
                    return;
                }
            }
            if (tries >= 150) { fallback(); return; }
            setTimeout(poll, 150);
        })();
    }

    function authHeaders() {
        var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (sid) headers.Cookie = 'SID=' + sid;
        return headers;
    }

    function doLogin(callback) {
        var c = cfg();
        if (c.bypass || !c.user) { loggedIn = true; callback(true); return; }
        nativeRequest({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body: 'username=' + encodeURIComponent(c.user) + '&password=' + encodeURIComponent(c.pass),
            headers: CT_FORM
        }, function (response) {
            if (!response || /Forbidden|403|Fails/i.test(response) || !/^Ok\./i.test(String(response).trim())) {
                loggedIn = false;
                notify('Ошибка авторизации qBittorrent');
                callback(false);
                return;
            }
            var match = /SID=([^;\s]+)/i.exec(String(response));
            if (match) sid = match[1];
            loggedIn = true;
            callback(true);
        });
    }

    function qbRequest(request, callback) {
        var c = cfg();
        if (c.bypass || !c.user) {
            nativeRequest(request, callback);
            return;
        }
        function send() {
            request.headers = authHeaders();
            nativeRequest(request, callback);
        }
        if (!loggedIn) doLogin(function (ok) { if (ok) send(); else callback(null); });
        else send();
    }

    function qbGet(path, callback) {
        qbRequest({ url: base() + path, method: 'GET', headers: authHeaders() }, callback);
    }

    function qbPost(path, body, callback) {
        qbRequest({ url: base() + path, method: 'POST', body: body, headers: authHeaders() }, callback);
    }

    function buildAddBody(magnet, title) {
        var c = cfg();
        var params = [
            'urls=' + encodeURIComponent(magnet),
            'savepath=' + encodeURIComponent(cleanPath(c.savepath)),
            'autoTMM=false',
            'contentLayout=NoSubfolder',
            'paused=false',
            'sequentialDownload=false'
        ];
        if (c.category) params.push('category=' + encodeURIComponent(c.category));
        if (c.rename && title) params.push('rename=' + encodeURIComponent(title));
        return params.join('&');
    }

    function getTorrentInfo(hash, callback) {
        qbGet('/api/v2/torrents/info?hashes=' + encodeURIComponent(hash), function (response) {
            if (typeof response !== 'string' || !response.length) { callback(null); return; }
            try {
                var data = JSON.parse(response);
                var list = Array.isArray(data) ? data : (data.torrents || []);
                if (!list.length) { callback(null); return; }
                var torrent = list[0];
                // Используем хеш, который вернул сам qBittorrent.
                torrent.hash = String(torrent.hash || hash).trim().toLowerCase();
                callback(torrent);
            } catch (e) {
                log('torrent info parse error:', response, e);
                callback(null);
            }
        });
    }

    // Получение файлов с повторными попытками: API иногда возвращает пустой массив,
    // пока qBittorrent получает метаданные или ещё формирует список содержимого.
    function getTorrentFiles(hash, callback, attempt) {
        attempt = attempt || 0;
        if (!hash) { callback(null); return; }

        qbGet('/api/v2/torrents/files?hash=' + encodeURIComponent(hash), function (response) {
            var files = null;
            try {
                if (typeof response === 'string' && response.trim()) {
                    var parsed = JSON.parse(response);
                    if (Array.isArray(parsed)) files = parsed;
                } else if (Array.isArray(response)) {
                    files = response;
                }
            } catch (e) {
                log('files parse error:', response, e);
            }

            if (files && files.length) {
                log('Получено файлов:', files.length, 'hash:', hash, 'attempt:', attempt + 1);
                callback(files);
                return;
            }

            log('Пустой список файлов; попытка', attempt + 1, 'из', FILE_RETRY_ATTEMPTS, 'hash:', hash, 'ответ:', response);

            if (attempt + 1 >= FILE_RETRY_ATTEMPTS) {
                callback(files || []);
                return;
            }

            setTimeout(function () {
                getTorrentFiles(hash, callback, attempt + 1);
            }, FILE_RETRY_INTERVAL);
        });
    }

    function checkTorrentProgress(hash, callback) {
        getTorrentInfo(hash, function (torrent) {
            callback(torrent ? Number(torrent.progress) || 0 : null);
        });
    }

    function verifyTorrentAdded(hash, attempt, callback) {
        attempt = attempt || 0;
        if (!hash) { callback(false); return; }
        checkTorrentProgress(hash, function (progress) {
            if (progress !== null) { callback(true); return; }
            if (attempt + 1 >= 8) { callback(false); return; }
            setTimeout(function () { verifyTorrentAdded(hash, attempt + 1, callback); }, 1000);
        });
    }

    function qbAdd(magnet, title, callback) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Не удалось получить magnet-ссылку');
            if (callback) callback(false);
            return;
        }
        notify('Отправляю в qBittorrent...');
        qbPost('/api/v2/torrents/add', buildAddBody(magnet, title), function (response) {
            if (response == null || /Forbidden|403|Fails|Errored/i.test(response)) {
                notify(response == null ? 'Нет связи с qBittorrent' : 'Ошибка добавления: ' + response);
                if (callback) callback(false);
                return;
            }
            var hash = magnetHash(magnet);
            if (!cfg().confirm) {
                notify('Отправлено в qBittorrent');
                if (callback) callback(true);
                return;
            }
            verifyTorrentAdded(hash, 0, function (found) {
                notify(found ? 'Торрент успешно добавлен' : 'Запрос отправлен. Проверьте список торрентов.');
                if (callback) callback(true, found);
            });
        });
    }

    function qbDelete(hashOrMagnet) {
        var hash = magnetHash(hashOrMagnet);
        if (!hash) { notify('Не удалось определить хеш торрента'); return; }
        var body = 'hashes=' + encodeURIComponent(hash) +
            '&deleteFiles=' + (cfg().delete_files ? 'true' : 'false');
        qbPost('/api/v2/torrents/delete', body, function (response) {
            if (response == null || /Forbidden|403|Fails/i.test(response)) {
                notify('Ошибка удаления торрента или нет связи');
                return;
            }
            notify(cfg().delete_files ? 'Торрент и его файлы удалены' : 'Торрент удалён из списка');
        });
    }

    function setFilePriority(hash, fileId, priority, callback) {
        var body = 'hash=' + encodeURIComponent(hash) +
            '&id=' + encodeURIComponent(fileId) +
            '&priority=' + encodeURIComponent(priority);
        qbPost('/api/v2/torrents/filePrio', body, function (response) {
            var ok = response !== null && response !== undefined &&
                !/Forbidden|403|Fails|Errored/i.test(String(response));
            if (callback) callback(ok, response);
        });
    }

    // Последовательно отключаем остальные файлы и включаем выбранный.
    // Ошибка любого запроса прерывает операцию, чтобы не сообщать ложный успех.
    function downloadSingleFile(hash, selected, files, callback) {
        if (!selected || selected.id === undefined) {
            notify('Не удалось определить файл');
            if (callback) callback(false);
            return;
        }
        notify('Назначаю загрузку выбранного файла...');
        var index = 0;
        function next() {
            if (index >= files.length) {
                setFilePriority(hash, selected.id, 1, function (ok) {
                    notify(ok ? 'Выбрана загрузка: ' + basename(selected.name) : 'Не удалось назначить загрузку файла');
                    if (callback) callback(ok);
                });
                return;
            }
            var file = files[index++];
            if (String(file.id) === String(selected.id)) { next(); return; }
            setFilePriority(hash, file.id, 0, function (ok) {
                if (!ok) {
                    notify('Не удалось изменить приоритет одного из файлов');
                    if (callback) callback(false);
                    return;
                }
                next();
            });
        }
        next();
    }

    function excludeSingleFile(hash, file, callback) {
        if (!file || file.id === undefined) {
            notify('Не удалось определить файл');
            if (callback) callback(false);
            return;
        }
        setFilePriority(hash, file.id, 0, function (ok) {
            notify(ok ? 'Файл исключён из загрузки: ' + basename(file.name) : 'Не удалось изменить приоритет файла');
            if (callback) callback(ok);
        });
    }

    function getEpisodeInfo(filename) {
        var name = basename(filename);
        var patterns = [
            /S(\d{1,2})E(\d{1,3})/i,
            /(\d{1,2})x(\d{1,3})/i,
            /Season[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})/i,
            /Сезон[\s._-]*(\d{1,2})[\s._-]*Серия[\s._-]*(\d{1,3})/i,
            /(\d{1,2})\s*сезон[\s._-]*(\d{1,3})\s*серия/i
        ];
        for (var i = 0; i < patterns.length; i++) {
            var m = patterns[i].exec(name);
            if (m) return { season: Number(m[1]), episode: Number(m[2]), found: true };
        }
        return { season: 0, episode: 0, found: false };
    }

    function compareVideoFiles(a, b) {
        var x = getEpisodeInfo(a.name), y = getEpisodeInfo(b.name);
        if (x.found && !y.found) return -1;
        if (!x.found && y.found) return 1;
        if (x.found && y.found) {
            if (x.season !== y.season) return x.season - y.season;
            if (x.episode !== y.episode) return x.episode - y.episode;
        }
        return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    }

    function openFileInPlayer(uri, title) {
        if (!uri) { notify('Не указан путь к видеофайлу'); return; }
        var c = cfg();
        var match = /\.([^.\/?#]+)(?:[?#]|$)/i.exec(uri);
        var ext = match ? '.' + match[1].toLowerCase() : '';
        var data = {
            url: uri, title: title || 'qBittorrent',
            source: 'qBittorrent', quality: 'auto', exe: ext
        };
        if (c.external_player) {
            if (window.AndroidJS && typeof window.AndroidJS.openPlayer === 'function') {
                try {
                    window.AndroidJS.openPlayer(uri, JSON.stringify(data));
                    return;
                } catch (e) {
                    log('openPlayer error:', e);
                    notify('Ошибка запуска видео');
                    return;
                }
            }
            notify('AndroidJS.openPlayer недоступен');
            return;
        }
        try {
            if (window.Lampa && Lampa.Player && typeof Lampa.Player.play === 'function') {
                Lampa.Player.play(data);
                return;
            }
        } catch (e) { log('Lampa.Player error:', e); }
        notify('Не удалось запустить плеер Lampa');
    }

    function playTorrentFile(file) {
        if (!file) { notify('Файл не выбран'); return; }
        if (Number(file.progress) < 0.999999) { notify('Этот файл ещё не загружен полностью'); return; }
        if (!isVideoFile(file.name)) { notify('Выбранный файл не является видео'); return; }
        var uri = makeSmbUri(file.name);
        log('Запуск файла:', file.name, 'размер:', formatSize(file.size), 'SMB:', uri);
        openFileInPlayer(uri, basename(file.name));
    }

    function refreshFileModal(hash) {
        getTorrentInfo(hash, function (torrent) {
            if (!torrent) { notify('Торрент не найден'); return; }
            getTorrentFiles(torrent.hash || hash, function (files) {
                if (!files || !files.length) { notify('qBittorrent не вернул список файлов'); return; }
                renderTorrentFiles(torrent.hash || hash, torrent, files);
            });
        });
    }

    function renderTorrentFiles(hash, torrent, files) {
        if (!window.Lampa || !Lampa.Modal) { notify('Окно файлов недоступно'); return; }
        var videoFiles = files.filter(function (file) { return isVideoFile(file.name); });
        videoFiles.sort(compareVideoFiles);
        if (!videoFiles.length) { notify('В торренте нет видеофайлов'); return; }

        var completed = videoFiles.filter(function (f) { return Number(f.progress) >= 0.999999; }).length;
        var html = document.createElement('div');
        html.className = 'qbit-files';

        var out = '<div class="qbit-files__header">' +
            '<div class="qbit-files__torrent">' + escapeHtml(torrent.name || 'Торрент') + '</div>' +
            '<div class="qbit-files__summary">Видео: ' + videoFiles.length + ' · Загружено: ' + completed + '</div>' +
            '<div class="qbit-files__hint">«Скачать» оставляет активным только выбранный файл</div></div><div class="qbit-files__list">';

        videoFiles.forEach(function (file) {
            var progress = Math.max(0, Math.min(100, Math.floor((Number(file.progress) || 0) * 100)));
            var ready = Number(file.progress) >= 0.999999;
            var excluded = Number(file.priority) === 0 && !ready;
            var status = ready ? 'Загружено' : (excluded ? 'Исключено из загрузки' : 'Загрузка: ' + progress + '%');
            var episode = getEpisodeInfo(file.name);
            var episodeLabel = episode.found ? 'Сезон ' + episode.season + ' · Серия ' + episode.episode : '';
            out += '<div class="qbit-file">' +
                '<div class="qbit-file__name">' + escapeHtml(basename(file.name)) + '</div>' +
                (episodeLabel ? '<div class="qbit-file__episode">' + escapeHtml(episodeLabel) + '</div>' : '') +
                '<div class="qbit-file__meta">' + escapeHtml(status) + ' · ' + formatSize(file.size) + '</div>' +
                '<div class="qbit-file__progress"><div style="width:' + progress + '%"></div></div>' +
                '<div class="qbit-file__actions">' +
                '<button class="qbit-file__button qbit-file__download" data-action="download" data-id="' + escapeHtml(file.id) + '">' + (ready ? 'Выбрать' : 'Скачать') + '</button>' +
                '<button class="qbit-file__button qbit-file__play" data-action="play" data-id="' + escapeHtml(file.id) + '"' + (ready ? '' : ' disabled') + '>Играть</button>' +
                '<button class="qbit-file__button qbit-file__exclude" data-action="exclude" data-id="' + escapeHtml(file.id) + '"' + (excluded ? ' disabled' : '') + '>Исключить</button>' +
                '</div></div>';
        });

        out += '</div><div class="qbit-files__footer">' +
            '<div class="qbit-files__warning">«Исключить» отключает загрузку, но не удаляет уже скачанный файл с диска. Для физического удаления нужен отдельный доступ к файловой системе.</div>' +
            '<button class="qbit-files__refresh">Обновить список</button></div>';
        html.innerHTML = out;

        Lampa.Modal.open({
            title: 'Файлы торрента',
            html: html,
            size: 'large',
            onBack: function () { Lampa.Modal.close(); }
        });

        if (!window.jQuery) {
            log('jQuery не найден: кнопки окна файлов не привязаны');
            return;
        }

        var $html = window.jQuery(html);
        function findFile(id) {
            for (var i = 0; i < files.length; i++) {
                if (String(files[i].id) === String(id)) return files[i];
            }
            return null;
        }

        $html.find('[data-action="download"]').on('hover:enter click', function (event) {
            event.preventDefault(); event.stopPropagation();
            var file = findFile(this.getAttribute('data-id'));
            if (!file) { notify('Файл не найден'); return; }
            downloadSingleFile(hash, file, files, function (ok) {
                if (ok) setTimeout(function () { refreshFileModal(hash); }, 700);
            });
        });

        $html.find('[data-action="play"]').on('hover:enter click', function (event) {
            event.preventDefault(); event.stopPropagation();
            var file = findFile(this.getAttribute('data-id'));
            if (file) playTorrentFile(file);
            else notify('Файл не найден');
        });

        $html.find('[data-action="exclude"]').on('hover:enter click', function (event) {
            event.preventDefault(); event.stopPropagation();
            var file = findFile(this.getAttribute('data-id'));
            if (!file) { notify('Файл не найден'); return; }
            excludeSingleFile(hash, file, function (ok) {
                if (ok) setTimeout(function () { refreshFileModal(hash); }, 700);
            });
        });

        $html.find('.qbit-files__refresh').on('hover:enter click', function (event) {
            event.preventDefault(); event.stopPropagation();
            refreshFileModal(hash);
        });
    }

    function handlePlayerButton(hash) {
        if (!hash) { notify('Не удалось определить хеш торрента'); return; }
        if (!requireSetup()) return;
        notify('Получаю информацию о торренте...');
        getTorrentInfo(hash, function (torrent) {
            if (!torrent) { notify('Торрент не найден в qBittorrent'); return; }
            var actualHash = String(torrent.hash || hash).trim().toLowerCase();
            log('Файлы запрашиваются по хешу:', actualHash, 'торрент:', torrent.name);
            notify('Получаю список файлов...');
            getTorrentFiles(actualHash, function (files) {
                if (!files || !files.length) {
                    notify('Не удалось получить список файлов. Проверьте, что qBittorrent получил метаданные.');
                    return;
                }
                renderTorrentFiles(actualHash, torrent, files);
            });
        });
    }

    function openSetupWizard(onDone) {
        if (!window.Lampa || !Lampa.Modal) { notify('Настройки: Настройки → qBittorrent'); return; }
        var c = cfg();
        var html = document.createElement('div');
        html.className = 'qbit-wizard';
        function field(id, label, value, example) {
            return '<div class="qbit-wizard__field"><label>' + label + '</label><input type="text" id="' + id + '" value="' + escapeHtml(value) + '"><div class="qbit-wizard__hint">Пример: ' + escapeHtml(example) + '</div></div>';
        }
        html.innerHTML = '<div class="qbit-wizard__desc">Укажите параметры qBittorrent. Настройки сохраняются в Lampa.</div>' +
            field('qbit-wz-url', 'Адрес сервера', c.url, EXAMPLE_URL) +
            field('qbit-wz-savepath', 'Путь загрузок на роутере', c.savepath, EXAMPLE_SAVEPATH) +
            field('qbit-wz-smb', 'SMB-шара', c.smb_file, EXAMPLE_SMB) +
            '<div class="qbit-wizard__actions"><button class="qbit-wizard__btn qbit-wizard__save">Сохранить</button><button class="qbit-wizard__btn qbit-wizard__cancel">Отмена</button></div>';
        Lampa.Modal.open({ title: 'qBittorrent — настройка', html: html, size: 'medium', onBack: function () { Lampa.Modal.close(); } });
        function close() { try { Lampa.Modal.close(); } catch (e) {} }
        if (window.jQuery) {
            window.jQuery(html).find('.qbit-wizard__cancel').on('hover:enter click', close);
            window.jQuery(html).find('.qbit-wizard__save').on('hover:enter click', function () {
                var url = html.querySelector('#qbit-wz-url').value.trim();
                var savepath = html.querySelector('#qbit-wz-savepath').value.trim();
                var smb = html.querySelector('#qbit-wz-smb').value.trim();
                if (!url || !savepath || !smb) { notify('Заполните все три поля'); return; }
                storeSet('qbit_url', url);
                storeSet('qbit_savepath', savepath);
                storeSet('qbit_smb_file', smb);
                close(); notify('Настройки сохранены');
                if (typeof onDone === 'function') onDone();
            });
        }
    }

    function addTorrent(magnet, title, callback) { qbAdd(magnet, title, callback); }

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
        if (window.jQuery) {
            window.jQuery(element).on('hover:enter', wrapped);
            window.jQuery(element).on('click', wrapped);
        } else element.addEventListener('click', wrapped);
    }

    function applyProgress(button, progress, icon) {
        if (!button) return;
        if (progress == null) {
            button.classList.remove('qbit-loading', 'qbit-done');
            button.innerHTML = icon + '<span class="qbit-btn-text">qB</span>';
        } else if (progress >= 1) {
            button.classList.remove('qbit-loading');
            button.classList.add('qbit-done');
            button.innerHTML = icon + '<span class="qbit-btn-text">Готов</span>';
        } else {
            button.classList.add('qbit-loading');
            button.classList.remove('qbit-done');
            button.innerHTML = icon + '<span class="qbit-btn-text">' + Math.max(0, Math.min(99, Math.floor(progress * 100))) + '%</span>';
        }
    }

    function stopPolling(button) {
        if (button && button._qbitTimer) {
            clearInterval(button._qbitTimer);
            button._qbitTimer = null;
        }
    }

    function startPolling(button, hash, item, icon) {
        if (!button || !hash || button._qbitTimer) return;
        button._qbitTimer = setInterval(function () {
            if (!document.body.contains(item) || !document.body.contains(button)) {
                stopPolling(button); return;
            }
            checkTorrentProgress(hash, function (progress) {
                if (!document.body.contains(button)) { stopPolling(button); return; }
                if (progress == null) {
                    stopPolling(button); applyProgress(button, null, icon); return;
                }
                applyProgress(button, progress, icon);
                if (progress >= 1) {
                    stopPolling(button);
                    notify('Загрузка завершена!');
                }
            });
        }, POLL_INTERVAL);
    }

    function restoreState(button, hash, item, icon) {
        if (!button || !hash) return;
        stopPolling(button);
        checkTorrentProgress(hash, function (progress) {
            if (!document.body.contains(button) || !document.body.contains(item)) return;
            applyProgress(button, progress, icon);
            if (progress != null && progress < 1) startPolling(button, hash, item, icon);
        });
    }

    function registerSettings() {
        if (!window.Lampa || !Lampa.SettingsApi) { log('SettingsApi unavailable'); return; }
        try {
            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });
            var params = [
                ['qbit_url', 'input', '', 'Адрес сервера', 'Пример: ' + EXAMPLE_URL],
                ['qbit_user', 'input', '', 'Логин', 'Логин Web UI'],
                ['qbit_pass', 'input', '', 'Пароль', 'Пароль Web UI'],
                ['qbit_bypass', 'trigger', true, 'Обход аутентификации', 'Для локальной сети'],
                ['qbit_savepath', 'input', '', 'Путь загрузки qBittorrent', 'Пример: ' + EXAMPLE_SAVEPATH],
                ['qbit_category', 'input', '', 'Категория', 'Например: video'],
                ['qbit_rename', 'trigger', true, 'Переименовывать торрент', ''],
                ['qbit_confirm', 'trigger', true, 'Проверять добавление', 'Проверять появление торрента после отправки'],
                ['qbit_delete_files', 'trigger', false, 'Удалять файлы при удалении торрента', 'Только при удалении всего торрента'],
                ['qbit_external_player', 'trigger', true, 'Использовать внешний плеер', 'DDD Player через AndroidJS'],
                ['qbit_player_package', 'input', 'top.rootu.dddplayer', 'Пакет внешнего плеера', 'DDD Player: top.rootu.dddplayer'],
                ['qbit_smb_file', 'input', '', 'Корень SMB-папки загрузок', 'Пример: ' + EXAMPLE_SMB]
            ];
            params.forEach(function (item) {
                Lampa.SettingsApi.addParam({
                    component: 'qbit_direct',
                    param: { name: item[0], type: item[1], values: '', default: item[2] },
                    field: { name: item[3], description: item[4] }
                });
            });
            log('Настройки зарегистрированы');
        } catch (e) { log('Settings registration:', e); }
    }

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu || typeof Lampa.Menu.addButton !== 'function') return;
            var icon = '<svg viewBox="0 0 24 24" width="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_direct"]');
                    if (item) item.click();
                }, 100);
            });
        } catch (e) { log('Menu:', e); }
    }

    function createButton(className, text, handler, icon) {
        var button = document.createElement('div');
        button.className = 'qbit-direct-btn ' + className + ' selector';
        button.tabIndex = 0;
        button.innerHTML = icon;
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
        if (!window.Lampa || !Lampa.Listener) { log('Listener unavailable'); return; }
        Lampa.Listener.follow('torrent', function (event) {
            try {
                if (!event || event.type !== 'render' || !event.item) return;
                var item = event.item.jquery ? event.item[0] : event.item;
                if (!item) return;
                var data = event.element || {};
                var container = item.querySelector('.torrent-item__right') || item.querySelector('.torrent-item') || item;
                if (container.querySelector('.qbit-direct-actions')) return;

                var magnet = extractMagnet(data) || extractMagnet(event);
                var hash = extractHash(data) || extractHash(event) || magnetHash(magnet);
                var title = data.Title || data.title || data.name || data.Name || '';
                var actions = document.createElement('div');
                actions.className = 'qbit-direct-actions';

                var downloadIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
                var playIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
                var deleteIcon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

                var playerButton = createButton('qbit-direct-player', '', function () {
                    var current = hash || extractHash(data) || extractHash(event) || magnetHash(magnet);
                    handlePlayerButton(current);
                }, playIcon);
                playerButton.title = 'Файлы торрента';

                var deleteButton = createButton('qbit-direct-delete', '', function () {
                    if (!requireSetup()) return;
                    var target = hash || magnet;
                    if (!target) { notify('Не удалось определить торрент'); return; }
                    qbDelete(target);
                }, deleteIcon);
                deleteButton.title = 'Удалить торрент';

                var addButton = createButton('qbit-direct-add', 'qB', function () {
                    if (!requireSetup()) return;
                    if (!magnet) { notify('Не найдена magnet-ссылка'); return; }
                    if (addButton.dataset.qbitAdding === '1') return;
                    addButton.dataset.qbitAdding = '1';
                    applyProgress(addButton, 0, downloadIcon);
                    addTorrent(magnet, title, function (success) {
                        addButton.dataset.qbitAdding = '0';
                        if (!success) { applyProgress(addButton, null, downloadIcon); return; }
                        if (!hash) hash = magnetHash(magnet);
                        if (!hash) { notify('Торрент добавлен, но хеш не определён'); return; }
                        startPolling(addButton, hash, item, downloadIcon);
                    });
                }, downloadIcon);
                addButton.title = 'Добавить торрент';

                if (hash) restoreState(addButton, hash, item, downloadIcon);
                actions.appendChild(addButton);
                actions.appendChild(playerButton);
                actions.appendChild(deleteButton);
                container.appendChild(actions);
            } catch (e) { log('torrent render handler:', e); }
        });
    }

    function syncSettingPlaceholders() {
        try {
            if (document.querySelector('.modal, .modal__content')) return;
            ['qbit_url', 'qbit_user', 'qbit_pass', 'qbit_savepath', 'qbit_category', 'qbit_smb_file', 'qbit_player_package'].forEach(function (name) {
                var item = document.querySelector('[data-name="' + name + '"]');
                if (!item) return;
                var value = item.querySelector('.value') || item.querySelector('.setting__value');
                if (!value) return;
                var stored = String(storeGet(name, ''));
                if (stored) {
                    if (value.textContent !== stored) value.textContent = stored;
                    value.classList.remove('qbit-empty-value');
                } else {
                    value.textContent = 'Не заполнено';
                    value.classList.add('qbit-empty-value');
                }
            });
        } catch (e) {}
    }

    function addStyles() {
        if (document.getElementById('qbit-direct-style')) return;
        var style = document.createElement('style');
        style.id = 'qbit-direct-style';
        style.textContent =
            '.torrent-item,.torrent-item__right{position:relative;margin-right:32px!important}' +
            '.qbit-direct-actions{display:flex;flex-direction:column;justify-content:center;align-items:center;position:absolute;right:-28px;top:0;bottom:0;z-index:999;gap:6px}' +
            '.qbit-direct-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;width:24px;height:24px;background:none!important;border:0!important;padding:0;cursor:pointer;box-sizing:border-box;transition:transform .2s}' +
            '.qbit-direct-btn.focus{transform:scale(1.15);outline:none}' +
            '.qbit-direct-btn svg{width:20px;height:20px;fill:#27ae60}' +
            '.qbit-btn-text{font-size:8px;font-weight:bold;margin-top:-2px;line-height:1;color:#27ae60}' +
            '.qbit-direct-player svg{fill:#3498db}.qbit-direct-delete svg{fill:#e74c3c}' +
            '.qbit-loading{opacity:.7}.qbit-done{opacity:1}' +
            '.qbit-empty-value{opacity:.5!important;font-style:italic}' +
            '.qbit-files{padding:12px;max-height:75vh;overflow-y:auto}' +
            '.qbit-files__header{margin-bottom:14px}.qbit-files__torrent{font-size:15px;font-weight:bold;margin-bottom:6px;overflow-wrap:anywhere}' +
            '.qbit-files__summary{font-size:13px;opacity:.8;margin-bottom:5px}.qbit-files__hint{font-size:12px;opacity:.6}' +
            '.qbit-file{display:flex;flex-direction:column;gap:9px;padding:12px 0;border-top:1px solid rgba(128,128,128,.25)}' +
            '.qbit-file__name{font-size:14px;font-weight:bold;overflow-wrap:anywhere}.qbit-file__episode{font-size:12px;opacity:.7;margin-top:3px}' +
            '.qbit-file__meta{font-size:12px;opacity:.7;margin-top:5px}' +
            '.qbit-file__progress{height:4px;background:rgba(128,128,128,.25);border-radius:4px;overflow:hidden;margin-top:7px}' +
            '.qbit-file__progress div{height:100%;background:#27ae60;transition:width .3s}' +
            '.qbit-file__actions{display:flex;flex-wrap:wrap;gap:7px}' +
            '.qbit-file__button,.qbit-files__refresh{border:0;border-radius:5px;padding:8px 12px;font-size:12px;color:#fff;background:#555;cursor:pointer}' +
            '.qbit-file__download{background:#218c54}.qbit-file__play{background:#2878b9}.qbit-file__exclude{background:#a94442}' +
            '.qbit-file__button:disabled{opacity:.35}.qbit-files__footer{padding-top:12px;border-top:1px solid rgba(128,128,128,.25)}' +
            '.qbit-files__warning{font-size:11px;opacity:.65;margin-bottom:10px;line-height:1.4}' +
            '.qbit-files__refresh{background:#555;width:100%;padding:10px}' +
            '.qbit-wizard{padding:20px}.qbit-wizard__desc{font-size:14px;margin-bottom:14px}.qbit-wizard__field{margin-bottom:12px}' +
            '.qbit-wizard__field label{display:block;font-size:12px;margin-bottom:4px;opacity:.7}' +
            '.qbit-wizard__field input{width:100%;padding:8px 10px;font-size:14px;box-sizing:border-box;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:inherit}' +
            '.qbit-wizard__hint{font-size:11px;margin-top:4px;opacity:.5}.qbit-wizard__actions{display:flex;gap:10px;margin-top:16px}' +
            '.qbit-wizard__btn{padding:10px 18px;font-size:14px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.1);color:inherit;cursor:pointer}' +
            '.qbit-wizard__save{background:#27ae60;border-color:#27ae60;color:#fff}';
        document.head.appendChild(style);
    }

    function initializePlugin() {
        try {
            log('Инициализация...');
            registerSettings();
            addMenuItem();
            initTorrentButton();
            addStyles();
            syncSettingPlaceholders();
            setInterval(syncSettingPlaceholders, 1500);
            log('Путь загрузки:', cfg().savepath || '(не задан)');
            log('SMB:', cfg().smb_file || '(не задан)');
            log('Плеер:', cfg().player_package);
            log('contentLayout: NoSubfolder; управление файлами включено');
        } catch (e) { log('Initialization error:', e); }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        var initialized = false;
        function initOnce() {
            if (initialized || !window.Lampa || !Lampa.Listener) return;
            initialized = true;
            initializePlugin();
        }
        document.addEventListener('appready', initOnce);
        setTimeout(function () {
            initOnce();
            if (!initialized) log('Lampa недоступна после ожидания');
        }, 5000);
    }
})();
