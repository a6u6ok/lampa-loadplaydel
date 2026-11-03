(function(){
'use strict';

var EXAMPLE_URL='http://192.168.1.1:9080',
    EXAMPLE_SAVEPATH='/mnt/storage/torrents',
    EXAMPLE_SMB='smb://192.168.1.1/Media/';

var LOCK_MS=800,
    POLL_MS=3000,
    VERIFY_MS=1000,
    VERIFY_N=8,
    FILES_RETRY_MS=1500,
    FILES_RETRY_N=7;

var AUTO_STOP_KEY='qbit_auto_stop_hashes',
    AUTO_STOP_INTERVAL=5000,
    AUTO_STOP_ALL_KEY='qbit_stop_all',
    DEBUG_KEY='qbit_debug';

var reqId=0,
    sid='',
    loggedIn=false,
    modalHash='',
    modalReq=0,
    autoStopTimer=null,
    autoStopChecking=false,
    autoStopping={};

var addingMagnets={};

var CT={'Content-Type':'application/x-www-form-urlencoded'};

var VIDEO=[
    'mkv','mp4','avi','m4v','mov','wmv','mpg','mpeg',
    'ts','m2ts','webm','flv','vob','ogv','3gp'
];

var TEXT_FIELDS=[
    'qbit_url',
    'qbit_user',
    'qbit_savepath',
    'qbit_smb_file',
    'qbit_smb_user'
];

var SVG_STAR='<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

var SVG_DOWN='<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

var SVG_PLAY='<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

var SVG_DEL='<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

function notify(msg){
    msg=String(msg===undefined||msg===null?'':msg);
    try{
        if(window.Lampa&&Lampa.Noty&&typeof Lampa.Noty.show==='function')
            return Lampa.Noty.show(msg);
    }catch(e){
        try{console.error('[qBittorrent] Ошибка уведомления:',e);}catch(ignore){}
    }
    try{console.log('[qBittorrent]',msg);}catch(e){}
    return false;
}

function debugEnabled(){
    return isTrue(storeGet(DEBUG_KEY, true), true);
}

function log(){
    if(debugEnabled()){
        console.log.apply(
            console,
            ['[qBittorrent]'].concat([].slice.call(arguments))
        );
    }
}

function debugNotify(msg){
    if(debugEnabled())notify(msg);
}

function debugError(){
    if(debugEnabled())
        console.error.apply(console,arguments);
}

window.addEventListener('error',function(e){
    if(!debugEnabled())return;

    debugError(
        '[qBittorrent] SCRIPT ERROR:',
        e.message,
        'строка:',
        e.lineno,
        e.error
    );
});

window.addEventListener('unhandledrejection',function(e){
    if(!debugEnabled())return;

    debugError('[qBittorrent] PROMISE ERROR:',e.reason);
});
function storeGet(k,d){
    try{
        var v=Lampa.Storage.get(k,d);
        return v===undefined||v===null||v===''?d:v;
    }catch(e){
        return d;
    }
}

function storeSet(k,v){
    try{
        Lampa.Storage.set(k,v);
    }catch(e){}
}

function isTrue(v,d){
    if(v===true||v==='true'||v===1||v==='1')return true;
    if(v===false||v==='false'||v===0||v==='0')return false;
    return d;
}

function cfg() {
    return {
        url: String(storeGet('qbit_url', '') || '').trim(),
        user: String(storeGet('qbit_user', '') || ''),
        pass: String(storeGet('qbit_pass', '') || ''),
        bypass: isTrue(storeGet('qbit_bypass', true), true),
        stopAll: isTrue(storeGet(AUTO_STOP_ALL_KEY, false), false),
        createFolder: isTrue(
            storeGet('qbit_create_folder', false),
            false
        ),
        savepath: String(storeGet('qbit_savepath', '') || '').trim(),
        smb: String(storeGet('qbit_smb_file', '') || '').trim(),
        smbAnonymous: isTrue(
            storeGet('qbit_smb_anonymous', false),
            false
        ),
        smbUser: String(storeGet('qbit_smb_user', 'user') || ''),
        smbPass: String(storeGet('qbit_smb_pass', '') || '')
    };
}
function configured(){
    var c=cfg();
    return!!(c.url&&c.savepath&&c.smb);
}

function requireSetup(){
    if(configured())return true;

    notify('Сначала настройте qBittorrent');
    openWizard();

    return false;
}

function base(){
    return cfg().url.replace(/\/+$/,'');
}

function cleanPath(p){
    return String(p||'')
        .replace(/\\/g,'/')
        .replace(/\/+/g,'/')
        .replace(/\/+$/,'');
}

function smbEncode(p){
    return String(p||'')
        .replace(/\\/g,'/')
        .split('/')
        .filter(function(s){
            return s!=='';
        })
        .map(encodeURIComponent)
        .join('/');
}

function basename(p){
    return String(p||'')
        .replace(/\\/g,'/')
        .split('/')
        .pop();
}

function isVideo(n){
    var m=/\.([^.\/\\]+)$/.exec(String(n||'').toLowerCase());
    return!!(m&&VIDEO.indexOf(m[1])!==-1);
}

function fmtSize(b){
    b=Number(b)||0;

    return b>=1073741824
        ?(b/1073741824).toFixed(2)+' GB'
        :b>=1048576
            ?(b/1048576).toFixed(1)+' MB'
            :b>=1024
                ?(b/1024).toFixed(1)+' KB'
                :b+' B';
}

function esc(v){
    return String(v===undefined?'':v)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
}

var EP_PATTERNS=[
    /S(\d{1,2})E(\d{1,3})/i,
    /(?:^|\D)(\d{1,2})x(\d{1,3})(?!\d)/i,
    /Season[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})/i,
    /Сезон[\s._-]*(\d{1,2})[\s._-]*Серия[\s._-]*(\d{1,3})/i,
    /(\d{1,2})\s*сезон[\s._-]*(\d{1,3})\s*серия/i
];

function episodeInfo(name){
    var n=basename(name);

    for(var i=0;i<EP_PATTERNS.length;i++){
        var m=EP_PATTERNS[i].exec(n);

        if(m){
            return{
                season:+m[1],
                episode:+m[2],
                found:true
            };
        }
    }

    return{
        season:0,
        episode:0,
        found:false
    };
}

function cmpFiles(a,b){
    var ea=episodeInfo(a.name),
        eb=episodeInfo(b.name);

    if(ea.found!==eb.found)
        return ea.found?-1:1;

    if(ea.found&&ea.season!==eb.season)
        return ea.season-eb.season;

    if(ea.found&&ea.episode!==eb.episode)
        return ea.episode-eb.episode;

    return String(a.name).localeCompare(
        String(b.name),
        undefined,
        {
            numeric:true,
            sensitivity:'base'
        }
    );
}

function base32ToHex(value){
    value=String(value||'').toUpperCase();

    if(!/^[A-Z2-7]{32}$/.test(value))
        return'';

    var alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        bits=0,
        buffer=0,
        bytes=[];

    for(var i=0;i<value.length;i++){
        var n=alphabet.indexOf(value.charAt(i));

        if(n<0)return'';

        buffer=(buffer<<5)|n;
        bits+=5;

        if(bits>=8){
            bits-=8;
            bytes.push((buffer>>bits)&255);
        }
    }

    if(bytes.length!==20)return'';

    return bytes.map(function(b){
        return('0'+b.toString(16)).slice(-2);
    }).join('');
}

function magnetHash(v){
    v=String(v||'').trim();

    if(!v)return'';

    var decoded=v;

    try{
        decoded=decodeURIComponent(v);
    }catch(e){}

    var m=/urn:btih:([a-zA-Z0-9]+)/i.exec(decoded);

    if(m){
        var btih=m[1];

        if(/^[a-f0-9]{40}$/i.test(btih))
            return btih.toLowerCase();

        if(/^[a-z2-7]{32}$/i.test(btih))
            return base32ToHex(btih);

        return'';
    }

    m=/urn:btmh:1220([a-f0-9]{64})/i.exec(decoded);

    if(m)
        return m[1].toLowerCase();

    if(/^[a-f0-9]{40}$/i.test(v)||/^[a-f0-9]{64}$/i.test(v))
        return v.toLowerCase();

    return'';
}

function extractMagnet(d){
    if(typeof d==='string')
        return/^magnet:\?/i.test(d)?d:'';

    if(typeof d!=='object'||!d)return'';

    var f=[
        'MagnetUri',
        'magnetUri',
        'magnet_uri',
        'magnet',
        'Magnet',
        'url',
        'torrent_url',
        'torrentUrl',
        'link'
    ];

    for(var i=0;i<f.length;i++){
        var v=d[f[i]];

        if(typeof v==='string'&&/^magnet:\?/i.test(v))
            return v;
    }

    return'';
}

function extractHash(d,depth){
    depth=depth||0;

    if(!d||typeof d!=='object'||depth>5)
        return'';

    var f=[
        'infohash',
        'infoHash',
        'InfoHash',
        'infohash_v1',
        'infoHashV1',
        'infohash_v2',
        'infoHashV2',
        'btih'
    ];

    for(var i=0;i<f.length;i++){
        if(d[f[i]]){
            var h=magnetHash(d[f[i]]);
            if(h)return h;
        }
    }

    var magnet=extractMagnet(d);

    if(magnet){
        var mh=magnetHash(magnet);
        if(mh)return mh;
    }

    var nested=[
        'torrent',
        'item',
        'data',
        'element',
        'source',
        'model',
        'card'
    ];

    for(var j=0;j<nested.length;j++){
        if(d[nested[j]]){
            var r=extractHash(d[nested[j]],depth+1);
            if(r)return r;
        }
    }

    return'';
}

function normResponse(r){
    if(r===null||r===undefined)return null;

    if(typeof r==='string')return r;

    if(typeof r==='object'){
        if(typeof r.responseText==='string')
            return r.responseText;

        if(typeof r.response==='string')
            return r.response;

        if(typeof r.body==='string')
            return r.body;

        if(typeof r.data==='string')
            return r.data;

        try{
            return JSON.stringify(r);
        }catch(e){
            return null;
        }
    }

    return String(r);
}

function fetchHttp(request,cb){
    if(typeof fetch!=='function')
        return cb(null);

    var opts={
        method:request.method||'GET',
        headers:request.headers||CT,
        credentials:'include'
    };

    if(request.body!=null)
        opts.body=request.body;

    fetch(request.url,opts)
        .then(function(r){
            if(!r.ok)
                throw new Error('HTTP '+r.status);

            return r.text();
        })
        .then(cb,function(e){
            debugError('[qBittorrent] fetch:',e);
            cb(null);
        });
}

function nativeHttp(request,cb){
    if(
        !window.AndroidJS||
        typeof window.AndroidJS.httpReq!=='function'||
        typeof window.AndroidJS.getResp!=='function'
    ){
        return fetchHttp(request,cb);
    }

    var id=++reqId,
        done=false,
        start=Date.now(),
        tries=0,
        emptyOk=Number(request.emptySuccessAfter)||0;

    var payload={
        url:request.url,
        timeout:20000,
        headers:request.headers||{}
    };

    if(request.body!=null)
        payload.post_data=String(request.body);

    function finish(r){
        if(!done){
            done=true;
            cb(normResponse(r));
        }
    }

    try{
        window.AndroidJS.httpReq(JSON.stringify(payload),id);
    }catch(e){
        debugError('[qBittorrent] httpReq:',e);
        return fetchHttp(request,cb);
    }

    (function poll(){
        if(done)return;

        var r=null;

        try{
            r=window.AndroidJS.getResp(String(id));
        }catch(e){}

        var t=r!==null&&r!==undefined
            ?normResponse(r)
            :null;

        if(t&&t.length)
            return finish(t);

        /*
         * Некоторые версии AndroidJS не отдают пустое тело ответа
         * как отдельное завершённое значение. Таймер используется только
         * для команд, после которых отдельно проверяется состояние qB.
         */
        if(emptyOk&&Date.now()-start>=emptyOk)
            return finish(t||'');

        if(++tries>=133)
            return finish(null);

        setTimeout(poll,150);
    })();
}

function authHeaders(){
    var h={
        'Content-Type':'application/x-www-form-urlencoded'
    };

    if(sid)h.Cookie='SID='+sid;

    return h;
}

function doLogin(cb){
    var c=cfg();

    if(c.bypass){
        loggedIn=true;
        return cb(true);
    }

    if(!c.user||!c.pass){
        loggedIn=false;
        sid='';
        notify('Укажите логин и пароль qBittorrent или включите обход авторизации');
        return cb(false);
    }

    nativeHttp({
        url:base()+'/api/v2/auth/login',
        method:'POST',
        body:'username='+encodeURIComponent(c.user)+
             '&password='+encodeURIComponent(c.pass),
        headers:CT
    },function(resp){

        if(
            !resp||
            /Forbidden|403|Fails/i.test(resp)||
            !/^Ok\./i.test(String(resp).trim())
        ){
            loggedIn=false;
            sid='';
            notify('Ошибка авторизации qBittorrent');
            return cb(false);
        }

        var m=/SID=([^;\s]+)/i.exec(String(resp));

        sid=m?m[1]:'';
        loggedIn=true;
        cb(true);
    });
}

function qbRequest(request,cb,retry){
    var c=cfg();

    if(c.bypass)
        return nativeHttp(request,cb);

    if(!c.user||!c.pass){
        loggedIn=false;
        sid='';
        notify('Для доступа к qBittorrent укажите логин и пароль либо включите обход авторизации');
        return cb(null);
    }

    function send(){
        request.headers=authHeaders();

        nativeHttp(request,function(resp){
            var expired=resp===null||/Forbidden|403/i.test(String(resp));

            if(expired&&!retry){
                loggedIn=false;
                sid='';
                return qbRequest(request,cb,true);
            }

            cb(resp);
        });
    }

    if(!loggedIn)
        return doLogin(function(ok){
            ok?send():cb(null);
        });

    send();
}

function qbGet(path,cb){
    qbRequest({
        url:base()+path,
        method:'GET',
        headers:authHeaders()
    },cb);
}

function qbPost(path,body,cb){
    qbRequest({
        url:base()+path,
        method:'POST',
        body:body,
        headers:authHeaders()
    },cb);
}

function parseTorrents(resp){
    if(typeof resp!=='string'||!resp.trim())
        return null;

    try{
        var d=JSON.parse(resp);

        if(Array.isArray(d))
            return d;

        if(d&&Array.isArray(d.torrents))
            return d.torrents;

    }catch(e){
        log('Ошибка разбора torrents/info:',e);
    }

    return null;
}

function addBody(magnet, title) {
    var c = cfg();

    var p = [
        'urls=' + encodeURIComponent(magnet),
        'savepath=' + encodeURIComponent(cleanPath(c.savepath)),
        'autoTMM=false',
        'contentLayout=' + (c.createFolder ? 'Subfolder' : 'NoSubfolder'),
        'paused=false',
        'sequentialDownload=false'
    ];

    if (title) p.push('rename=' + encodeURIComponent(title));

    return p.join('&');
}

/*
 * Переименовывает именно физическую корневую папку торрента.
 * /torrents/rename меняет только отображаемое имя раздачи,
 * поэтому для каталога используем /torrents/renameFolder.
 */
function safeTorrentFolderName(name){
    return String(name||'').replace(/\s+/g,'_').trim();
}

function renameTorrentFolder(hash,torrent,cb){
    cb=typeof cb==='function'?cb:function(t){return t;};

    if(!cfg().createFolder)
        return cb(torrent);

    torrentFiles(hash,0,function(files){
        if(!Array.isArray(files)||!files.length){
            log('Не удалось получить список файлов для переименования папки');
            return cb(torrent);
        }

        /*
         * В torrents/files поле name содержит путь внутри торрента.
         * При Subfolder корневая папка — первый сегмент этого пути.
         */
        var roots=[];
        files.forEach(function(file){
            var path=normalizeRelativePath(file&&file.name||'');
            if(!path)return;
            var slash=path.indexOf('/');
            if(slash>0){
                var root=path.substring(0,slash);
                if(roots.indexOf(root)<0)roots.push(root);
            }
        });

        if(roots.length!==1){
            log('Не удалось однозначно определить корневую папку торрента:',roots);
            return cb(torrent);
        }

        var oldName=roots[0];
        var newName=safeTorrentFolderName(oldName);

        if(!newName||newName===oldName||! /\s/.test(oldName))
            return cb(torrent);

        log('Переименование физической папки торрента:',oldName,'→',newName);

        qbPost(
            '/api/v2/torrents/renameFolder',
            'hash='+encodeURIComponent(hash)+
            '&oldPath='+encodeURIComponent(oldName)+
            '&newPath='+encodeURIComponent(newName),
            function(resp){
                if(resp==null||/Forbidden|403|Errored|Fails|Conflict|404/i.test(String(resp))){
                    log('qBittorrent не переименовал папку:',resp,'oldPath:',oldName,'newPath:',newName);
                    return cb(torrent);
                }

                log('Физическая папка торрента переименована:',newName);
                torrentInfo(hash,function(updated){
                    cb(updated||torrent);
                });
            }
        );
    });
}

function torrentInfo(hash,cb){
    var target=String(hash||'').trim().toLowerCase();

    if(!target)return cb&&cb(null);

    function match(t){
        if(!t)return false;

        return[
            t.hash,
            t.infohash_v1,
            t.infohash_v2
        ].some(function(v){
            return String(v||'').trim().toLowerCase()===target;
        });
    }

    qbGet(
        '/api/v2/torrents/info?hashes='+encodeURIComponent(target),
        function(resp){
            var list=parseTorrents(resp);

            if(list&&list.length){
                var exact=list.filter(match)[0];
                if(exact)return cb(exact);
            }

            qbGet('/api/v2/torrents/info',function(all){
                var found=(parseTorrents(all)||[])
                    .filter(match)[0]||null;

                if(!found)
                    log('Торрент не найден по хешу:',target);

                cb(found);
            });
        }
    );
}

function torrentProgress(hash,cb){
    if(!hash)return cb(null);

    torrentInfo(hash,function(t){
        if(!t)return cb(null);

        var p=Number(t.progress);
        if(!isFinite(p))p=0;

        cb(Math.max(0,Math.min(1,p)));
    });
}

function verifyAdded(hash,attempt,cb){
    attempt=attempt||0;

    if(!hash)return cb(null);

    torrentInfo(hash,function(t){
        if(t)return cb(t);

        if(attempt+1>=VERIFY_N)
            return cb(null);

        setTimeout(function(){
            verifyAdded(hash,attempt+1,cb);
        },VERIFY_MS);
    });
}

function qbAdd(magnet,title,cb){
    cb=typeof cb==='function'?cb:function(){};

    if(!magnet||!/^magnet:\?/i.test(magnet)){
        notify('Не удалось получить magnet-ссылку');
        return cb(false,null);
    }

    var hash=magnetHash(magnet);

    if(!hash){
        notify('Не удалось определить infohash magnet-ссылки');
        return cb(false,null);
    }

    var key=hash.toLowerCase();

    if(addingMagnets[key]){
        log('Повторный запрос заблокирован:',key);
        addingMagnets[key].push(cb);
        notify('Этот торрент уже добавляется');
        return;
    }

    addingMagnets[key]=[cb];

    function finish(ok,torrent,message){
        var callbacks=addingMagnets[key]||[];
        delete addingMagnets[key];

        if(message)notify(message);

        callbacks.forEach(function(fn){
            try{
                fn(!!ok,torrent||null);
            }catch(e){
                debugError('[qBittorrent] callback добавления:',e);
            }
        });
    }

    debugNotify('Проверяю наличие торрента...');

    torrentInfo(hash,function(existing){
        if(existing){
            log('Торрент уже существует:',existing.name,key);

            return renameTorrentFolder(key,existing,function(updated){
                finish(
                    true,
                    updated||existing,
                    'Торрент уже есть в qBittorrent. Подключено отслеживание.'
                );
            });
        }

        debugNotify('Отправляю в qBittorrent...');

        qbPost(
            '/api/v2/torrents/add',
            addBody(magnet,title),
            function(resp){

                if(resp==null){
                    return finish(false,null,'Нет связи с qBittorrent');
                }

                if(/Forbidden|403|Errored|Fails/i.test(String(resp))){
                    return finish(false,null,'Ошибка добавления: '+resp);
                }

                verifyAdded(hash,0,function(found){
                    if(!found){
                        return finish(
                            false,
                            null,
                            'qBittorrent не подтвердил добавление торрента. Проверьте список загрузок.'
                        );
                    }

                    log(
                        'Добавление подтверждено:',
                        found.name,
                        found.hash,
                        'progress:',
                        found.progress,
                        'state:',
                        found.state
                    );

                    renameTorrentFolder(key,found,function(updated){
                        finish(
                            true,
                            updated||found,
                            'Торрент успешно найден в qBittorrent'
                        );
                    });
                });
            }
        );
    });
}
function verifyTorrentDeleted(hash,attempt,absentCount,cb){
    attempt=attempt||0;
    absentCount=absentCount||0;

    qbGet(
        '/api/v2/torrents/info?hashes='+encodeURIComponent(hash),
        function(resp){
            var list=parseTorrents(resp);

            /* null означает ошибку/неполный ответ, а не отсутствие торрента. */
            if(!list){
                if(attempt+1>=10)
                    return cb(false,'Не удалось проверить список торрентов');

                return setTimeout(function(){
                    verifyTorrentDeleted(hash,attempt+1,0,cb);
                },700);
            }

            var exists=list.some(function(t){
                return String(t.hash||'').trim().toLowerCase()===hash;
            });

            if(exists){
                if(attempt+1>=10)
                    return cb(false,'qBittorrent всё ещё показывает этот торрент');

                return setTimeout(function(){
                    verifyTorrentDeleted(hash,attempt+1,0,cb);
                },700);
            }

            /* Требуем два последовательных подтверждения отсутствия. */
            if(absentCount+1>=2)
                return cb(true);

            setTimeout(function(){
                verifyTorrentDeleted(hash,attempt+1,absentCount+1,cb);
            },500);
        }
    );
}

function qbDelete(hashOrMagnet,cb){
    cb=typeof cb==='function'?cb:function(){};

    var hash=magnetHash(hashOrMagnet);

    if(!hash){
        notify('Не удалось определить хеш торрента');
        return cb(false);
    }

    log('Отправляю запрос на удаление торрента и файлов:',hash);

    qbRequest({
        url:base()+'/api/v2/torrents/delete',
        method:'POST',
        body:'hashes='+encodeURIComponent(hash)+'&deleteFiles=true',
        headers:authHeaders(),
        emptySuccessAfter:1500
    },function(resp){

        if(resp!==null&&/Forbidden|403|Fails|Errored/i.test(String(resp))){
            notify('qBittorrent отклонил удаление торрента');
            return cb(false);
        }

        if(resp===null)
            log('Ответ команды удаления не получен; проверяю фактическое состояние торрента');

        verifyTorrentDeleted(hash,0,0,function(removed,reason){
            if(!removed){
                log('Удаление не подтверждено:',hash,reason||'торрент всё ещё присутствует');
                notify(reason||'Не удалось подтвердить удаление торрента');
                return cb(false);
            }

            /* Убираем из списка автоконтроля только после подтверждённого удаления. */
            forgetManagedTorrent(hash);
            notify('Торрент удалён из qBittorrent');
            cb(true);
        });
    });
}

function getManagedHashes(){
    var h=storeGet(AUTO_STOP_KEY,[]);

    if(typeof h==='string'){
        try{
            h=JSON.parse(h);
        }catch(e){
            h=[];
        }
    }

    if(!Array.isArray(h))return[];

    return h.map(function(x){
        return String(x||'').trim().toLowerCase();
    }).filter(Boolean);
}

function rememberManagedTorrent(hash){
    hash=String(hash||'').trim().toLowerCase();
    if(!hash)return;

    var h=getManagedHashes();

    if(h.indexOf(hash)===-1){
        h.push(hash);
        storeSet(AUTO_STOP_KEY,h);
        log('Торрент добавлен в автоматический контроль:',hash);
    }
}

function forgetManagedTorrent(hash){
    hash=String(hash||'').trim().toLowerCase();

    storeSet(
        AUTO_STOP_KEY,
        getManagedHashes().filter(function(h){
            return h!==hash;
        })
    );

    delete autoStopping[hash];
}

function qbStopTorrent(hash,cb){
    hash=String(hash||'').trim().toLowerCase();

    if(!hash)return cb&&cb(false);

    qbRequest({
        url:base()+'/api/v2/torrents/pause',
        method:'POST',
        body:'hashes='+encodeURIComponent(hash),
        headers:authHeaders(),
        emptySuccessAfter:1500
    },function(resp){

        if(
            resp===null||
            /Forbidden|403|Fails|Errored/i.test(String(resp))
        ){
            log('Команда остановки не выполнена:',hash,resp);
            return cb&&cb(false);
        }

        setTimeout(function(){
            torrentInfo(hash,function(t){
                var state=String(t&&t.state||'');
                var stopped=/^(paused|stopped)/i.test(state);

                log('Проверка остановки:',hash,state||'нет ответа');

                if(!stopped)
                    log('Остановка пока не подтверждена:',hash);

                cb&&cb(stopped);
            });
        },800);
    });
}

/*
 * Автоматическая остановка раздач.
 * stopAll=true  — все завершённые раздачи qBittorrent.
 * stopAll=false — только торренты, добавленные через Lampa.
 */
function checkAutoStop(){
    if(autoStopChecking||!base())return;

    autoStopChecking=true;

    qbGet('/api/v2/torrents/info',function(resp){
        autoStopChecking=false;

        var torrents=parseTorrents(resp);

        if(!torrents){
            log('Не удалось получить полный список торрентов для автопроверки');
            return;
        }

        var managed=getManagedHashes(),
            stopAll=cfg().stopAll;

        log(
            'Автопроверка: получено торрентов:',
            torrents.length,
            'Режим:',
            stopAll?'все торренты':'только Lampa'
        );

        torrents.forEach(function(t){
            var hash=String(t.hash||'').trim().toLowerCase();

            if(!hash)return;

            /*
             * В режиме «Нет» игнорируем все торренты,
             * которых нет в сохранённом списке Lampa.
             */
            if(!stopAll&&managed.indexOf(hash)===-1)
                return;

            var progress=Number(t.progress);
            var state=String(t.state||'');

            if(!isFinite(progress)||progress<0.999999)
                return;

            if(/^(paused|stopped)/i.test(state)){
    // Сохраняем хеш: пользователь мог остановить торрент вручную.
    delete autoStopping[hash];
    return;
}

            if(
                !/^(uploading|stalledUP|queuedUP|forcedUP)$/i.test(state)||
                autoStopping[hash]
            ){
                return;
            }

            autoStopping[hash]=true;

            log(
                'Обнаружен полностью загруженный торрент. Останавливаю:',
                t.name,
                'Хеш:',
                hash,
                'Состояние:',
                state
            );

            qbStopTorrent(hash,function(ok){
                if(ok){
                    forgetManagedTorrent(hash);

                    notify(
                        'Торрент загружен на 100%. Раздача остановлена: '+
                        (t.name||hash)
                    );
                }else{
                    delete autoStopping[hash];

                    log(
                        'Остановка не подтверждена. Повторная попытка через',
                        AUTO_STOP_INTERVAL,
                        'мс:',
                        t.name||hash
                    );
                }
            });
        });
    });
}

function startAutoStopMonitor(){
    if(autoStopTimer)return;

    log('Запуск автоматического контроля раздачи');

    checkAutoStop();

    autoStopTimer=setInterval(
        checkAutoStop,
        AUTO_STOP_INTERVAL
    );
}

/*
 * SMB URI используется одинаково на Windows, Android TV и Android.
 * При анонимном доступе логин и пароль в URI не добавляются.
 */
// ========================================================================
// SMB, ФОРМИРОВАНИЕ ПУТИ И ЗАПУСК ПЛЕЕРА
// ========================================================================

function smbUri(name) {
    var c = cfg();

    var root = String(c.smb || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');

    if (!/^smb:\/\//i.test(root)) {
        notify('Укажите корректный адрес SMB-папки');
        return '';
    }

    var match = /^smb:\/\/([^/]+)(\/.*)?$/i.exec(root);

    if (!match) {
        notify('Некорректный адрес SMB-папки');
        return '';
    }

    var authority = match[1].replace(/^[^@]*@/, '');
    var path = match[2] || '';

    if (!c.smbAnonymous) {
        if (!c.smbUser || !c.smbPass) {
            notify(
                'Укажите логин и пароль SMB-сервера ' +
                'или включите анонимный доступ'
            );
            return '';
        }

        var auth = encodeURIComponent(c.smbUser) +
            ':' + encodeURIComponent(c.smbPass);

        root = 'smb://' + auth + '@' + authority + path;
    } else {
        root = 'smb://' + authority + path;
    }

    var file = normalizeRelativePath(name);

    if (!file) {
        notify('Не удалось определить относительный путь к файлу');
        return '';
    }

    return root + '/' + smbEncode(file);
}

/*
 * Нормализация относительного пути.
 * Убирает начальные слеши, точки и небезопасные переходы на уровень выше.
 */
function normalizeRelativePath(path) {
    path = String(path || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

    var parts = path.split('/');
    var result = [];

    parts.forEach(function (part) {
        if (!part || part === '.') return;

        if (part === '..') {
            if (result.length) result.pop();
            return;
        }

        result.push(part);
    });

    return result.join('/');
}

/*
 * Проверяет, находится ли абсолютный путь внутри каталога загрузки.
 * Возвращает относительную часть пути либо пустую строку.
 */
function relativeToSavePath(path, savepath) {
    path = cleanPath(path);
    savepath = cleanPath(savepath);

    if (!path || !savepath) return '';

    var normalizedPath = path.replace(/\/+$/, '');
    var normalizedRoot = savepath.replace(/\/+$/, '');

    if (normalizedPath === normalizedRoot) return '';

    var prefix = normalizedRoot + '/';

    if (normalizedPath.indexOf(prefix) === 0) {
        return normalizeRelativePath(
            normalizedPath.substring(prefix.length)
        );
    }

    return '';
}

/*
 * Определяет правильный относительный путь файла на SMB.
 *
 * qBittorrent API:
 * - file.name — относительное имя файла внутри торрента;
 * - torrent.content_path — абсолютный путь к содержимому торрента;
 * - torrent.save_path — каталог сохранения.
 *
 * При Subfolder content_path обычно указывает на папку торрента.
 * При NoSubfolder файлы находятся непосредственно в savepath.
 */
function resolveTorrentFilePath(file, torrent) {
    var c = cfg();

    if (!file || !file.name) return '';

    var fileName = normalizeRelativePath(file.name);

    if (!fileName) return '';

    var saveRoot = cleanPath(
        torrent && torrent.save_path
            ? torrent.save_path
            : c.savepath
    );

    var contentPath = cleanPath(
        torrent && torrent.content_path
            ? torrent.content_path
            : ''
    );

    var contentRelative = relativeToSavePath(
        contentPath,
        saveRoot
    );

    var contentBase = basename(contentPath);
    var fileBase = basename(fileName);

    var numFiles = Number(torrent && torrent.num_files);
    var isMultiFile = isFinite(numFiles) && numFiles > 1;

    /*
     * Если content_path указывает на сам файл,
     * а не на папку, используем его относительный путь.
     */
    if (
        contentRelative &&
        !isMultiFile &&
        contentBase &&
        contentBase.toLowerCase() === fileBase.toLowerCase()
    ) {
        return contentRelative;
    }

    /*
     * Если qBittorrent уже включил папку торрента
     * в file.name, второй раз её не добавляем.
     */
    if (contentRelative) {
        var prefix = contentRelative.replace(/\/+$/, '') + '/';

        if (
            fileName.toLowerCase().indexOf(prefix.toLowerCase()) === 0
        ) {
            return fileName;
        }

        /*
         * Для многфайлового торрента content_path указывает
         * на папку. Добавляем её к file.name.
         */
        if (isMultiFile) {
            return normalizeRelativePath(
                contentRelative + '/' + fileName
            );
        }

        /*
         * Если имя файла уже совпадает с content_path,
         * не добавляем путь повторно.
         */
        if (
            contentRelative.toLowerCase() === fileName.toLowerCase()
        ) {
            return fileName;
        }

        /*
         * Для однофайлового торрента используем имя файла,
         * если content_path не указывает непосредственно на него.
         */
        return fileName;
    }

    /*
     * Резервный вариант для Subfolder:
     * если content_path не пришёл от API, используем имя торрента.
     * Не добавляем папку, если она уже присутствует в file.name.
     */
    if (c.createFolder && isMultiFile && torrent && torrent.name) {
        var torrentFolder = normalizeRelativePath(torrent.name);

        if (torrentFolder) {
            var folderPrefix = torrentFolder + '/';

            if (
                fileName.toLowerCase().indexOf(
                    folderPrefix.toLowerCase()
                ) !== 0
            ) {
                return normalizeRelativePath(
                    torrentFolder + '/' + fileName
                );
            }
        }
    }

    return fileName;
}

function safeUriForLog(uri) {
    return String(uri || '').replace(
        /^(smb:\/\/)[^/]*@/i,
        '$1***@'
    );
}

function openPlayer(uri, title) {
    uri = String(uri || '').trim();

    if (!uri) {
        notify('Не указан путь к видеофайлу');
        return;
    }

    var m = /\.([^.\/\\]+)$/.exec(uri);

    var data = {
        url: uri,
        title: title || 'qBittorrent',
        source: 'qBittorrent',
        quality: 'auto',
        exe: m ? '.' + m[1].toLowerCase() : ''
    };

    if (
        window.AndroidJS &&
        typeof window.AndroidJS.openPlayer === 'function'
    ) {
        try {
            log('Передача SMB-видео в плеер:', safeUriForLog(uri));

            return window.AndroidJS.openPlayer(
                uri,
                JSON.stringify(data)
            );
        } catch (e) {
            debugError('[qBittorrent] AndroidJS.openPlayer:', e);
            notify('Ошибка запуска плеера Lampa');
            return;
        }
    }

    try {
        if (
            window.Lampa &&
            Lampa.Player &&
            typeof Lampa.Player.play === 'function'
        ) {
            log('Запуск через Lampa.Player:', safeUriForLog(uri));
            return Lampa.Player.play(data);
        }
    } catch (e) {
        debugError('[qBittorrent] Lampa.Player:', e);
    }

    notify('Не удалось запустить плеер Lampa');
}

function playFile(file, torrent) {
    if (!file) return notify('Файл не выбран');

    var p = Number(file.progress);

    if (!isFinite(p) || p < 0.999999) {
        return notify('Этот файл ещё не загружен полностью');
    }

    if (!isVideo(file.name)) {
        return notify('Выбранный файл не является видео');
    }

    var relativePath = resolveTorrentFilePath(file, torrent);

    if (!relativePath) {
        return notify('Не удалось сформировать путь к файлу');
    }

    var uri = smbUri(relativePath);

    if (!uri) return;

    log(
        'Запуск файла:',
        file.name,
        'Относительный путь:',
        relativePath,
        'Путь загрузки:',
        torrent && torrent.save_path,
        'Путь содержимого:',
        torrent && torrent.content_path,
        'Размер:',
        fmtSize(file.size),
        'SMB:',
        safeUriForLog(uri)
    );

    openPlayer(uri, basename(file.name));
}

function torrentFiles(hash,attempt,cb){
    attempt=attempt||0;

    qbGet(
        '/api/v2/torrents/files?hash='+encodeURIComponent(hash),
        function(resp){
            var files=[];

            try{
                if(typeof resp==='string'&&resp.length)
                    files=JSON.parse(resp);
            }catch(e){
                debugError(
                    '[qBittorrent] Ошибка разбора списка файлов:',
                    resp,
                    e
                );
            }

            if(Array.isArray(files)&&files.length){
                log('Получено файлов:',files.length);
                return cb(files);
            }

            log(
                'Список файлов пуст. Попытка:',
                attempt+1,
                'Хеш:',
                hash,
                'Ответ:',
                resp
            );

            if(attempt>=FILES_RETRY_N)
                return cb([]);

            setTimeout(function(){
                torrentFiles(hash,attempt+1,cb);
            },FILES_RETRY_MS);
        }
    );
}

function fileIndex(f){
    if(!f)return null;

    if(f.index!==undefined&&f.index!==null&&f.index!=='')
        return f.index;

    if(f.id!==undefined&&f.id!==null&&f.id!=='')
        return f.id;

    return null;
}

function findFile(files,id){
    if(!Array.isArray(files)||id==null||id==='')
        return null;

    for(var i=0;i<files.length;i++){
        var cur=fileIndex(files[i]);

        if(cur!==null&&String(cur)===String(id))
            return files[i];
    }

    return null;
}

function centerFocus(el,box){
    if(!el||!box)return;

    var row=el.closest?el.closest('.qbit-file'):null;
    if(!row)return;

    var outer=box.getBoundingClientRect();
    var inner=row.getBoundingClientRect();

    if(!inner.height||!outer.height)return;

    var target=
        box.scrollTop+
        (inner.top-outer.top)+
        (inner.height/2)-
        (outer.height/2);

    box.scrollTop=Math.max(
        0,
        Math.min(
            Math.max(0,box.scrollHeight-box.clientHeight),
            target
        )
    );
}

function focusFirst(list){
    setTimeout(function(){
        var sel=
            '.qbit-file__button.selector:not(:disabled), '+
            '.qbit-files__refresh.selector';

        var btn=list.querySelector(sel);
        if(!btn)return;

        try{
            btn.focus();
            centerFocus(btn,list);

            if(
                window.Lampa&&
                Lampa.Controller&&
                typeof Lampa.Controller.collectionFocus==='function'
            ){
                Lampa.Controller.collectionFocus(false,sel);
            }
        }catch(e){
            log('Не удалось установить фокус:',e);
        }
    },150);
}

function renderFiles(hash,torrent,files){
    if(!window.Lampa||!Lampa.Modal)
        return notify('Окно файлов недоступно');

    if(!window.jQuery)
        return notify('Не удалось открыть список файлов: jQuery недоступен');

    var video=(files||[])
        .filter(function(f){
            return isVideo(f.name);
        })
        .sort(cmpFiles);

    if(!video.length)
        return notify('В торренте нет видеофайлов');

    var done=video.filter(function(f){
        return Number(f.progress)>=0.999999;
    }).length;

    var html=
        '<div class="qbit-files">'+
            '<div class="qbit-files__header">'+
                '<div class="qbit-files__torrent">'+
                    esc(torrent&&torrent.name||'Торрент')+
                '</div>'+
                '<div class="qbit-files__summary">'+
                    'Видео: '+video.length+' · Загружено: '+done+
                '</div>'+
                '<div class="qbit-files__hint">'+
                    'Выберите файл для воспроизведения'+
                '</div>'+
            '</div>'+
            '<div class="qbit-files__list">';

    video.forEach(function(f){
        var pct=Math.max(
            0,
            Math.min(
                100,
                Math.floor((Number(f.progress)||0)*100)
            )
        );

        var ready=pct>=100;
        var id=fileIndex(f);
        var idAttr=id===null?'':String(id);
        var ep=episodeInfo(f.name);

        html+=
            '<div class="qbit-file" data-file-id="'+
                esc(idAttr)+
            '">'+
                '<div class="qbit-file__info">'+
                    '<div class="qbit-file__name">'+
                        esc(basename(f.name))+
                    '</div>'+
                    (
                        ep.found
                        ?'<div class="qbit-file__episode">'+
                            'Сезон '+ep.season+
                            ' · Серия '+ep.episode+
                         '</div>'
                        :''
                    )+
                    '<div class="qbit-file__meta">'+
                        (
                            ready
                            ?'Загружено'
                            :'Загрузка: '+pct+'%'
                        )+
                        ' · '+fmtSize(f.size)+
                    '</div>'+
                    '<div class="qbit-file__progress">'+
                        '<div style="width:'+pct+'%"></div>'+
                    '</div>'+
                '</div>'+
                '<div class="qbit-file__actions">'+
                    '<button type="button" '+
                        'class="qbit-file__button qbit-file__play selector'+
                            (ready?' qbit-file__play--ready':'')+
                        '" '+
                        'tabindex="0" '+
                        'data-action="play" '+
                        'data-id="'+esc(idAttr)+'"'+
                        (ready?'':' disabled')+
                    '>Смотреть</button>'+
                '</div>'+
            '</div>';
    });

    html+=
            '</div>'+
            '<div class="qbit-files__footer">'+
                '<button type="button" '+
                    'class="qbit-files__refresh selector" '+
                    'tabindex="0">'+
                    'Обновить список'+
                '</button>'+
            '</div>'+
        '</div>';

    var el=document.createElement('div');
    el.innerHTML=html;

    if(modalHash===hash){
        try{
            Lampa.Modal.close();
        }catch(e){}
    }

    modalHash=hash;

    Lampa.Modal.open({
        title:'Файлы торрента',
        html:window.jQuery(el),
        size:'large',
        align:'top',
        mask:true,

        onBack:function(){
            modalHash='';
            modalReq++;

            Lampa.Modal.close();
            Lampa.Controller.toggle('content');
        }
    });

    var list=el.querySelector('.qbit-files');
    focusFirst(list);

    /*
     * Защита от двойного события hover:enter + click.
     * Само окно списка не закрываем: после выхода из плеера
     * пользователь возвращается к этому же списку серий.
     */
    var lastPlayAt = 0;
    var lastPlayId = '';

    window.jQuery(el)
        .find('[data-action="play"]')
        .on('hover:enter click',function(e){
            if(e){
                e.preventDefault();
                e.stopPropagation();
                if(e.stopImmediatePropagation)e.stopImmediatePropagation();
            }

            var fileId = this.getAttribute('data-id') || '';
            var now = Date.now();

            /* Одно нажатие Lampa иногда передаёт двумя событиями. */
            if(fileId === lastPlayId && now - lastPlayAt < 1200)
                return;

            lastPlayAt = now;
            lastPlayId = fileId;

            var f=findFile(files,fileId);

            if(!f){
                notify('Файл не найден в полученном списке qBittorrent');

                return log(
                    'Не найден файл. Индекс:',
                    fileId
                );
            }

            playFile(f, torrent);
        })
        .end()
        .find('.qbit-files__refresh')
        .on('hover:enter click',function(e){
            e.preventDefault();
            e.stopPropagation();
            refreshFiles(hash);
        })
        .end()
        .on('focusin hover:focus','.selector',function(){
            centerFocus(this,list);
        });

    var lastFocused=null;

    function correctFocusPosition(current){
        if(!current||!document.body.contains(current))
            return;

        [0,60,150,300].forEach(function(delay){
            setTimeout(function(){
                if(
                    document.body.contains(current)&&
                    current.classList.contains('focus')
                ){
                    centerFocus(current,list);
                }
            },delay);
        });
    }

    var focusWatcher=setInterval(function(){
        if(!document.body.contains(list)){
            clearInterval(focusWatcher);
            return;
        }

        var current=list.querySelector(
            '.qbit-file__button.focus:not(:disabled), '+
            '.qbit-files__refresh.focus'
        );

        if(!current||current===lastFocused)
            return;

        lastFocused=current;
        correctFocusPosition(current);
    },80);
}

function refreshFiles(hash){
    var req=++modalReq;

    torrentInfo(hash,function(t){
        if(req!==modalReq)return;

        if(!t)return notify('Торрент не найден');

        torrentFiles(
            String(t.hash||hash).trim().toLowerCase(),
            0,
            function(files){
                if(req!==modalReq)return;

                if(!files||!files.length)
                    return notify('Не удалось обновить список файлов');

                renderFiles(hash,t,files);
            }
        );
    });
}

/*
 * Защита от устаревших ответов:
 * если пользователь открыл другой торрент,
 * старый запрос больше не сможет заменить новый список.
 */
function openFiles(hash){
    if(!hash)
        return notify('Не удалось определить хеш торрента');

    if(!requireSetup())return;

    var req=++modalReq;

    log('Открытие списка файлов по кнопке Play. Хеш:',hash);
    debugNotify('Получаю список файлов...');

    torrentInfo(hash,function(t){
        if(req!==modalReq)return;

        if(!t)
            return notify('Торрент не найден в qBittorrent');

        var h=String(t.hash||hash).trim().toLowerCase();

        torrentFiles(h,0,function(files){
            if(req!==modalReq)return;

            if(!files||!files.length)
                return notify('Не удалось получить список файлов торрента');

            if(!files.some(function(f){
                return isVideo(f.name);
            })){
                return notify('В торренте нет видеофайлов');
            }

            renderFiles(h,t,files);
        });
    });
}
    function bindPress(el,handler){
    var last=0;

    function wrap(e){
        var now=Date.now();

        if(now-last<LOCK_MS)return;
        last=now;

        if(e){
            if(e.preventDefault)e.preventDefault();
            if(e.stopPropagation)e.stopPropagation();
            if(e.stopImmediatePropagation)e.stopImmediatePropagation();
        }

        handler(e);
    }

    if(window.jQuery)
        window.jQuery(el).on('hover:enter click',wrap);
    else
        el.addEventListener('click',wrap);
}

function setProgress(btn,p,icon){
    if(!btn)return;

    btn.classList.remove('qbit-loading','qbit-done');

    if(p===null||p===undefined){
        btn.innerHTML=
            icon+
            '<span class="qbit-btn-text">qB</span>';
    }
    else if(p>=1){
        btn.classList.add('qbit-done');

        btn.innerHTML=
            icon+
            '<span class="qbit-btn-text">Готов</span>';
    }
    else{
        btn.classList.add('qbit-loading');

        btn.innerHTML=
            icon+
            '<span class="qbit-btn-text">'+
                Math.max(0,Math.min(99,Math.floor(p*100)))+
                '%'+
            '</span>';
    }
}

function stopPoll(btn){
    if(!btn)return;

    if(btn._qbitTimer){
        clearInterval(btn._qbitTimer);
        btn._qbitTimer=null;
    }

    btn.dataset.qbitPolling='0';
}

function startPoll(btn,hash,item,icon){
    if(!btn||!hash||btn._qbitTimer)return;

    btn.dataset.qbitPolling='1';

    btn._qbitTimer=setInterval(function(){
        try{
            if(
                !document.body.contains(item)||
                !document.body.contains(btn)
            ){
                return stopPoll(btn);
            }

            torrentProgress(hash,function(p){
                if(btn.dataset.qbitPolling!=='1')
                    return;

                if(!document.body.contains(btn))
                    return stopPoll(btn);

                if(p===null){
                    stopPoll(btn);
                    return setProgress(btn,null,icon);
                }

                if(p>=1){
                    stopPoll(btn);
                    setProgress(btn,1,icon);
                    notify('Загрузка завершена!');
                    return;
                }

                setProgress(btn,p,icon);
            });

        }catch(e){
            stopPoll(btn);
            debugError('[qBittorrent] polling:',e);
        }
    },POLL_MS);
}

/*
 * Важно: здесь НЕ добавляем торрент в список управляемых.
 * В список попадают только торренты, для которых пользователь
 * нажал кнопку добавления в Lampa.
 */
function restoreState(btn,hash,item,icon){
    if(!btn||!hash)return;

    stopPoll(btn);

    torrentProgress(hash,function(p){
        if(
            !document.body.contains(btn)||
            !document.body.contains(item)
        ){
            return;
        }

        setProgress(btn,p,icon);

        if(p!==null&&p<1)
            startPoll(btn,hash,item,icon);
    });
}

function openWizard(){
    if(!window.Lampa||!Lampa.Modal)
        return notify('Настройки: Настройки → qBittorrent');

    if(!window.jQuery)
        return notify('Не удалось открыть настройки: jQuery недоступен');

    var c=cfg();
    function field(id,label,value,example,type){
        return(
            '<div class="qbit-wizard__field">'+
                '<label for="'+id+'">'+label+'</label>'+
                '<input type="'+(type||'text')+'" id="'+id+'" value="'+esc(value)+'">'+
                '<div class="qbit-wizard__hint">Пример: '+esc(example)+'</div>'+
            '</div>'
        );
    }

    var el=document.createElement('div');
    el.className='qbit-wizard';

    el.innerHTML=
        '<div class="qbit-wizard__desc">'+
            'Укажите параметры qBittorrent. Настройки сохраняются в Lampa.'+
        '</div>'+
        field(
            'qbit-wz-url',
            'Адрес сервера qBittorrent',
            c.url,
            EXAMPLE_URL
        )+

        field(
            'qbit-wz-savepath',
            'Путь загрузок на сервере',
            c.savepath,
            EXAMPLE_SAVEPATH
        )+

        field(
            'qbit-wz-smb',
            'Адрес SMB-папки',
            c.smb,
            EXAMPLE_SMB
        )+
		'<div class="qbit-wizard__field">' +
    '<label for="qbit-wz-create-folder">' +
        'Создавать папку для торрента' +
    '</label>' +
    '<select id="qbit-wz-create-folder">' +
        '<option value="false"' +
            (!c.createFolder ? ' selected' : '') +
        '>Нет — загружать прямо в корень SMB</option>' +
        '<option value="true"' +
            (c.createFolder ? ' selected' : '') +
        '>Да — создавать папку с названием торрента</option>' +
    '</select>' +
    '<div class="qbit-wizard__hint">' +
        'Настройка влияет на новые загрузки' +
    '</div>' +
'</div>' +

        '<div class="qbit-wizard__field">'+
            '<label for="qbit-wz-smb-anonymous">Аноним SMB</label>'+
            '<select id="qbit-wz-smb-anonymous">'+
                '<option value="false"'+(!c.smbAnonymous?' selected':'')+'>Нет</option>'+
                '<option value="true"'+(c.smbAnonymous?' selected':'')+'>Да</option>'+
            '</select>'+
            '<div class="qbit-wizard__hint">Да — подключение без логина и пароля</div>'+
        '</div>'+

        field(
            'qbit-wz-smb-user',
            'Логин SMB сервера',
            c.smbUser,
            'user'
        )+

        field(
            'qbit-wz-smb-pass',
            'Пароль SMB сервера',
            c.smbPass,
            'Пароль пользователя SMB',
            'password'
        )+

        '<div class="qbit-wizard__actions">'+
            '<button class="qbit-wizard__btn qbit-wizard__save selector" tabindex="0">'+
                'Сохранить'+
            '</button>'+
            '<button class="qbit-wizard__btn qbit-wizard__cancel selector" tabindex="0">'+
                'Отмена'+
            '</button>'+
        '</div>';

    Lampa.Modal.open({
        title:'qBittorrent — настройка',
        html:window.jQuery(el),
        size:'medium',

        onBack:function(){
            Lampa.Modal.close();
            Lampa.Controller.toggle('content');
        }
    });

    var $el=window.jQuery(el);

    var anonymousSelect=el.querySelector('#qbit-wz-smb-anonymous');
    var smbUserInput=el.querySelector('#qbit-wz-smb-user');
    var smbPassInput=el.querySelector('#qbit-wz-smb-pass');

    function syncWizardSmb(){
        var anonymous=anonymousSelect.value==='true';

        smbUserInput.disabled=anonymous;
        smbPassInput.disabled=anonymous;

        smbUserInput.style.opacity=anonymous?'0.45':'1';
        smbPassInput.style.opacity=anonymous?'0.45':'1';
    }

    anonymousSelect.addEventListener('change',syncWizardSmb);
    syncWizardSmb();

    $el.find('.qbit-wizard__cancel')
        .on('hover:enter click',function(){
            try{
                Lampa.Modal.close();
            }catch(e){}
        });

    $el.find('.qbit-wizard__save')
        .on('hover:enter click',function(e){
            e.preventDefault();
            e.stopPropagation();

            var url=el.querySelector('#qbit-wz-url').value.trim();
            var path=el.querySelector('#qbit-wz-savepath').value.trim();
            var smb=el.querySelector('#qbit-wz-smb').value.trim();
            var anonymous = anonymousSelect.value === 'true';
var createFolder =
    el.querySelector('#qbit-wz-create-folder').value === 'true';

var smbUser = smbUserInput.value.trim();
var smbPass = smbPassInput.value;

            if(!url||!path||!smb)
                return notify('Заполните обязательные поля');

            if(!/^smb:\/\/[^/]+\/.+/i.test(smb))
                return notify('Укажите корректный адрес SMB-папки');

            if(!anonymous&&(!smbUser||!smbPass))
                return notify('Для SMB необходимо указать логин и пароль либо включить анонимный доступ');

            storeSet('qbit_url',url);
            storeSet('qbit_savepath',path);
            storeSet('qbit_smb_file',smb);
            storeSet('qbit_smb_anonymous',anonymous);
			storeSet('qbit_create_folder', createFolder);

            if(!anonymous){
                storeSet('qbit_smb_user',smbUser);
                storeSet('qbit_smb_pass',smbPass);
            }

            try{
                Lampa.Modal.close();
            }catch(err){}

            notify('Настройки сохранены');
            syncPlaceholders();
            syncSettingStates();
        });
}

function registerSettings(){
    try{
        if(!window.Lampa||!Lampa.SettingsApi)
            return debugError('[qBittorrent] SettingsApi unavailable');

        Lampa.SettingsApi.addComponent({
            component:'qbit_direct',
            icon:SVG_STAR,
            name:'qBittorrent'
        });

        [
            [
                'qbit_url',
                'input',
                '',
                'Адрес сервера qBittorrent',
                'Пример: '+EXAMPLE_URL
            ],
            [
                'qbit_bypass',
                'trigger',
                true,
                'Обход аутентификации qBittorrent',
                'Для локальной сети'
            ],
            [
                'qbit_user',
                'input',
                '',
                'Логин qBittorrent',
                'Логин Web UI'
            ],
            [
                'qbit_pass',
                'input',
                '',
                'Пароль qBittorrent',
                'Пароль Web UI'
            ],
            [
                AUTO_STOP_ALL_KEY,
                'trigger',
                false,
                'Останавливать все раздачи qBittorrent',
                'Да — все завершённые раздачи. Нет — только торренты, добавленные через Lampa'
            ],
			
            [
                'qbit_savepath',
                'input',
                '',
                'Путь загрузки qBittorrent',
                'Пример: '+EXAMPLE_SAVEPATH
            ],
						[
    'qbit_create_folder', 'trigger', false,
    'Создавать папку для торрента',
    'Да — отдельная папка с названием торрента. ' +
    'Нет — загрузка прямо в корень SMB'
],
            [
                'qbit_smb_file',
                'input',
                '',
                'Адрес SMB-папки',
                'Пример: '+EXAMPLE_SMB
            ],
            [
                'qbit_smb_anonymous',
                'trigger',
                false,
                'Анонимная аутентификация SMB сервера',
                'Да — подключаться без логина и пароля'
            ],
            [
                'qbit_smb_user',
                'input',
                'user',
                'Логин SMB сервера',
                'Логин пользователя SMB'
            ],
            [
                'qbit_smb_pass',
                'input',
                '',
                'Пароль SMB сервера',
                'Пароль пользователя SMB'
            ],
			[
    DEBUG_KEY,
    'trigger',
    true,
    'Режим отладки (DEBUG)',
    'Да — включить отладочные сообщения. Нет — отключить. Логи смотреть в самой Lampa.'
]

        ].forEach(function(it){
            Lampa.SettingsApi.addParam({
                component:'qbit_direct',

                param:{
                    name:it[0],
                    type:it[1],
                    values:'',
                    default:it[2]
                },

                field:{
                    name:it[3],
                    description:it[4]
                }
            });
        });

        log('Настройки зарегистрированы');

    }catch(e){
        debugError('[qBittorrent] Settings:',e);
    }
}

/*
 * Динамическое отключение полей авторизации.
 * Обход авторизации qBittorrent отключает логин/пароль Web UI.
 * Анонимный SMB отключает логин/пароль SMB-сервера.
 */
function syncSettingStates(){
    try{
        var c=cfg();

        function setDisabled(name,disabled){
            var item=document.querySelector(
                '[data-name="'+name+'"]'
            );

            if(!item)return;

            var controls=item.querySelectorAll(
                'input,textarea,select,button'
            );

            Array.prototype.forEach.call(controls,function(control){
                control.disabled=disabled;
            });

            item.style.opacity=disabled?'0.45':'1';
            item.style.pointerEvents=disabled?'none':'';
        }

        setDisabled('qbit_user',c.bypass);
        setDisabled('qbit_pass',c.bypass);

        setDisabled('qbit_smb_user',c.smbAnonymous);
        setDisabled('qbit_smb_pass',c.smbAnonymous);

    }catch(e){
        log('Ошибка обновления состояния настроек:',e);
    }
}

function addMenuItem(){
    try{
        if(
            !window.Lampa||
            !Lampa.Menu||
            typeof Lampa.Menu.addButton!=='function'
        ){
            return;
        }

        Lampa.Menu.addButton(
            SVG_STAR,
            'qBittorrent',
            function(){
                Lampa.Controller.toggle('settings');

                setTimeout(function(){
                    var item=document.querySelector(
                        '[data-component="qbit_direct"]'
                    );

                    if(item)item.click();

                    setTimeout(syncSettingStates,100);
                },100);
            }
        );

    }catch(e){
        debugError('[qBittorrent] Menu:',e);
    }
}

function syncPlaceholders(){
    try{
        if(document.querySelector('.modal, .modal__content'))
            return;

        TEXT_FIELDS.forEach(function(name){
            var item=document.querySelector(
                '[data-name="'+name+'"]'
            );

            if(!item)return;

            var v=
                item.querySelector('.value')||
                item.querySelector('.setting__value');

            if(!v)return;

            var stored=String(storeGet(name,''));

            if(stored){
                if(v.textContent!==stored)
                    v.textContent=stored;

                v.classList.remove('qbit-empty-value');

            }else if(v.textContent!=='Не заполнено'){
                v.textContent='Не заполнено';
                v.classList.add('qbit-empty-value');
            }
        });

        syncSettingStates();

    }catch(e){}
}

function makeBtn(cls,text,handler,icon){
    var b=document.createElement('div');

    b.className='qbit-direct-btn '+cls+' selector';
    b.tabIndex=0;
    b.setAttribute('role','button');
    b.innerHTML=icon;

    if(text){
        var s=document.createElement('span');

        s.textContent=text;
        s.className='qbit-btn-text';

        b.appendChild(s);
    }

    bindPress(b,handler);

    return b;
}

function initTorrentButton(){
    if(!window.Lampa||!Lampa.Listener)
        return debugError('[qBittorrent] Listener unavailable');

    Lampa.Listener.follow('torrent',function(event){
        try{
            if(!event||event.type!=='render'||!event.item)
                return;

            var item=event.item.jquery
                ?event.item[0]
                :event.item;

            if(!item)return;

            var data=event.element||{};

            var box=
                item.querySelector('.torrent-item__right')||
                item.querySelector('.torrent-item')||
                item;

            if(box.querySelector('.qbit-direct-actions'))
                return;

            var magnet=
                extractMagnet(data)||
                extractMagnet(event);

            var hash=
                magnetHash(magnet)||
                extractHash(data)||
                extractHash(event);

            var title=
                data.Title||
                data.title||
                data.name||
                data.Name||
                '';

            var actions=document.createElement('div');
            actions.className='qbit-direct-actions';

            var addBtn=makeBtn(
                'qbit-direct-add',
                'qB',
                function(){
                    if(!requireSetup()||addBtn.dataset.qbitAdding==='1')
                        return;

                    if(!magnet)
                        return notify('Не найдена magnet-ссылка');

                    var currentHash=magnetHash(magnet);

                    if(!currentHash)
                        return notify('Не удалось определить infohash magnet-ссылки');

                    addBtn.dataset.qbitAdding='1';
                    setProgress(addBtn,0,SVG_DOWN);

                    qbAdd(magnet,title,function(ok,torrent){
                        addBtn.dataset.qbitAdding='0';

                        if(!ok||!torrent){
                            stopPoll(addBtn);
                            return setProgress(addBtn,null,SVG_DOWN);
                        }

                        hash=String(torrent.hash||currentHash)
                            .trim()
                            .toLowerCase();

                        if(!hash){
                            notify('Торрент найден, но qBittorrent не вернул его хеш');
                            return setProgress(addBtn,null,SVG_DOWN);
                        }

                        /*
                         * Добавляем в управляемые только после нажатия
                         * кнопки qB в карточке Lampa.
                         */
                        rememberManagedTorrent(hash);

                        var p=Number(torrent.progress);
                        if(!isFinite(p))p=0;

                        setProgress(addBtn,p,SVG_DOWN);

                        if(p>=1){
                            stopPoll(addBtn);
                            setProgress(addBtn,1,SVG_DOWN);
                        }else{
                            startPoll(addBtn,hash,item,SVG_DOWN);
                        }
                    });
                },
                SVG_DOWN
            );

            addBtn.title='Добавить торрент';

            var playBtn=makeBtn(
                'qbit-direct-player',
                '',
                function(){
                    openFiles(
                        hash||
                        extractHash(data)||
                        extractHash(event)||
                        magnetHash(magnet)
                    );
                },
                SVG_PLAY
            );

            playBtn.title='Открыть список файлов торрента';

            var delBtn=makeBtn(
                'qbit-direct-delete',
                '',
                function(){
                    if(!requireSetup())return;

                    if(!hash&&!magnet)
                        return notify('Не удалось определить торрент');

                    qbDelete(hash||magnet,function(ok){
                        if(!ok)return;

                        stopPoll(addBtn);
                        setProgress(addBtn,null,SVG_DOWN);
                        hash='';
                    });
                },
                SVG_DEL
            );

            delBtn.title='Удалить торрент';

            if(hash)
                restoreState(addBtn,hash,item,SVG_DOWN);

            actions.appendChild(addBtn);
            actions.appendChild(playBtn);
            actions.appendChild(delBtn);

            box.classList.add('qbit-direct-host');
            box.appendChild(actions);

        }catch(e){
            debugError('[qBittorrent] render handler:',e);
        }
    });
}

function addStyles(){
    if(document.getElementById('qbit-direct-style'))
        return;

    var s=document.createElement('style');
    s.id='qbit-direct-style';

    s.textContent=
        '.qbit-direct-host{position:relative;margin-right:32px!important}'+
        '.qbit-direct-actions{display:flex;flex-direction:column;justify-content:center;align-items:center;position:absolute;right:-28px;top:0;bottom:0;z-index:999;gap:6px}'+
        '.qbit-direct-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;width:24px;height:24px;background:none!important;border:none!important;border-radius:0!important;padding:0;cursor:pointer;box-sizing:border-box;transition:transform .2s}'+
        '.qbit-direct-btn.focus{transform:scale(1.25);outline:none!important;box-shadow:none!important;background:none!important;border-radius:0!important;z-index:1000}'+
        '.qbit-direct-btn svg{width:20px;height:20px;fill:#27ae60}'+
        '.qbit-btn-text{font-size:8px;font-weight:bold;margin-top:-2px;line-height:1;color:#27ae60}'+
        '.qbit-direct-player svg{fill:#3498db}.qbit-direct-delete svg{fill:#e74c3c}'+
        '.qbit-loading{opacity:.7}.qbit-done{opacity:1}.qbit-done .qbit-btn-text{font-size:9px;color:#27ae60}'+
        '.qbit-empty-value{opacity:.5!important;font-style:italic}'+
        '.qbit-files{width:100%;max-height:75vh;overflow-y:auto;box-sizing:border-box;padding:16px}'+
        '.qbit-files__header{margin-bottom:14px}.qbit-files__torrent{font-size:15px;font-weight:bold;margin-bottom:6px;overflow-wrap:anywhere}'+
        '.qbit-files__summary{font-size:13px;opacity:.8;margin-bottom:5px}.qbit-files__hint{font-size:12px;opacity:.6}'+
        '.qbit-file{display:flex;flex-direction:column;gap:9px;padding:12px 0;border-top:1px solid rgba(128,128,128,.25)}'+
        '.qbit-file__name{font-size:14px;font-weight:bold;overflow-wrap:anywhere}.qbit-file__episode{font-size:12px;opacity:.7;margin-top:3px}'+
        '.qbit-file__meta{font-size:12px;opacity:.7;margin-top:5px}'+
        '.qbit-file__progress{height:4px;background:rgba(128,128,128,.25);border-radius:4px;overflow:hidden;margin-top:7px}'+
        '.qbit-file__progress div{height:100%;background:#27ae60;transition:width .3s}'+
        '.qbit-file__actions{display:flex;flex-wrap:wrap;gap:7px}'+
        '.qbit-file__button,.qbit-files__refresh{border:0;border-radius:5px;padding:8px 12px;font-size:12px;cursor:pointer;transition:transform .15s,background .15s,color .15s;outline:none!important;box-shadow:none!important}'+
        '.qbit-file__button.selector,.qbit-files__refresh.selector{position:relative;z-index:1}'+
        '.qbit-file__play--ready{background:rgba(255,255,255,.75)!important;color:rgba(0,0,0,.8)!important;font-weight:bold}'+
        '.qbit-file__button:not(.qbit-file__play--ready){background:rgba(255,255,255,.08)!important;color:rgba(255,255,255,.35)!important}'+
        '.qbit-file__button:disabled{opacity:.5;cursor:default}'+
        '.qbit-file__button.focus,.qbit-files__refresh.focus{transform:scale(1.05);outline:none!important;box-shadow:none!important;background:#27ae60!important;color:#fff!important;z-index:10}'+
        '.qbit-files__footer{padding-top:12px;border-top:1px solid rgba(128,128,128,.25)}'+
        '.qbit-files__refresh{background:rgba(255,255,255,.15)!important;color:#fff!important;width:100%;padding:10px}'+
        '.qbit-wizard{padding:20px}.qbit-wizard__desc{font-size:14px;margin-bottom:14px}.qbit-wizard__field{margin-bottom:12px}'+
        '.qbit-wizard__field label{display:block;font-size:12px;margin-bottom:4px;opacity:.7}'+
        '.qbit-wizard__field input,.qbit-wizard__field select{width:100%;padding:8px 10px;font-size:14px;box-sizing:border-box;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:inherit}'+
        '.qbit-wizard__field select option{color:#111}'+
        '.qbit-wizard__hint{font-size:11px;margin-top:4px;opacity:.5}.qbit-wizard__actions{display:flex;gap:10px;margin-top:16px}'+
        '.qbit-wizard__btn{padding:10px 18px;font-size:14px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.1);color:inherit;cursor:pointer;outline:none!important;box-shadow:none!important}'+
        '.qbit-wizard__btn.focus{outline:none!important;box-shadow:none!important;background:#27ae60!important;color:#fff!important}'+
        '.qbit-wizard__save{background:#27ae60;border-color:#27ae60;color:#fff}.qbit-wizard__save.focus{background:#1e8449!important}';

    document.head.appendChild(s);
}

function init(){
    try{
        log('Инициализация плагина...');

        registerSettings();
        addMenuItem();
        initTorrentButton();
        addStyles();
        startAutoStopMonitor();

        syncPlaceholders();
        syncSettingStates();

        setInterval(syncPlaceholders,1500);
        setInterval(syncSettingStates,1000);

        log(
            'Путь загрузки:',
            cfg().savepath||'(не задан)'
        );

        log(
            'Адрес SMB-папки:',
            safeUriForLog(cfg().smb)||'(не задан)'
        );

        log('Анонимный SMB:',cfg().smbAnonymous?'включён':'выключен');

        log(
            'Автоматическая остановка:',
            cfg().stopAll
                ?'все завершённые раздачи qBittorrent'
                :'только торренты, добавленные через Lampa'
        );

        log(
            'Интервал проверки:',
            AUTO_STOP_INTERVAL,
            'мс'
        );

log(
    'contentLayout:',
    cfg().createFolder ? 'Subfolder' : 'NoSubfolder'
);

log(
    'Создание папки торрента:',
    cfg().createFolder ? 'включено' : 'выключено'
);

log(
    'index из torrents/files. Центрирование выбранного файла включено.'
);

        log('Плагин загружен');

    }catch(e){
        debugError('[qBittorrent] Initialization:',e);
    }
}

if(window.Lampa&&Lampa.Listener){
    init();
}else{
    var started=false;

    function once(){
        if(
            started||
            !window.Lampa||
            !Lampa.Listener
        ){
            return;
        }

        started=true;
        init();
    }

    document.addEventListener('appready',once);

    setTimeout(function(){
        once();

        if(!started)
            log('Lampa недоступна после таймаута ожидания');

    },5000);
}

})();
