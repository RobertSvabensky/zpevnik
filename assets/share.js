/* assets/share.js
   Sdílení – host/klient, schvalování, pauza, broadcast navigace
   Počítá s Firestore a firebase compat (window.firebase).
*/

(function(){
  "use strict";

  const COLL = "zpevnikShare";          // kolekce sessions, docId = 5místný kód
  const TTL_MINUTES = 60;               // bez aktivity => uvolnit (logicky)
  const HEARTBEAT_MS = 30 * 1000;       // 30 s

  // Stav na zařízení
  let db = null;

  let role = "none"; // none | host | client
  let code = "";
  let nick = "";
  let myId = "";
  let paused = false;

  let hostUnsub = null;
  let clientUnsub = null;
  let clientsUnsub = null;
  let hbTimer = null;

  // Callbacky od aplikace:
  // getCurrentState(): objekt reprezentující "kde jsem" (např. {songId:"...", view:"song"})
  // applyState(state): provede navigaci podle state (zobrazení písně apod.)
  let getCurrentState = null;
  let applyState = null;

  // UI prvky
  let btnShare, modal, inpNick, inpCode, btnJoin, btnLeave, btnPause, btnResume, btnClose;
  let statusEl, listWrap, listEl, hostTools;

  function now(){ return Date.now(); }
  function clampCode(s){
    s = String(s || "").replace(/\D/g,"").slice(0,5);
    return s;
  }
  function makeId(){
    // stabilní id pro zařízení (lokálně uložené)
    const key = "zpevnik_share_device_id";
    let v = localStorage.getItem(key);
    if(!v){
      v = "d_" + Math.random().toString(36).slice(2,10) + "_" + Date.now().toString(36);
      localStorage.setItem(key, v);
    }
    return v;
  }

  function setBtnState(state){
    // state: normal | host | client | paused
    btnShare.classList.remove("share-host","share-client","share-paused");
    if(state === "host") btnShare.classList.add("share-host");
    if(state === "client") btnShare.classList.add("share-client");
    if(state === "paused") btnShare.classList.add("share-paused");
  }

  function openModal(){
    modal.classList.add("open");
    // předvyplnit
    inpNick.value = nick || localStorage.getItem("zpevnik_share_nick") || "";
    inpCode.value = code || "";
    updateModalUI();
  }
  function closeModal(){
    modal.classList.remove("open");
  }

  function setStatus(msg){
    statusEl.textContent = msg || "";
  }

  function updateModalUI(){
    // podle role a paused ukázat správná tlačítka
    const isHost = role === "host";
    const isClient = role === "client";

    btnJoin.style.display = (role === "none") ? "" : "none";

    // host nástroje
    hostTools.style.display = isHost ? "" : "none";
    listWrap.style.display  = isHost ? "" : "none";

    // klient nástroje
    btnPause.style.display  = (isClient && !paused) ? "" : "none";
    btnResume.style.display = (isClient && paused) ? "" : "none";

    btnLeave.style.display  = (isHost || isClient) ? "" : "none";
  }

  function getSessionRef(code){
    return db.collection(COLL).doc(code);
  }

  async function ensureFirebase(){
    if(!window.firebase || !window.firebase.firestore){
      throw new Error("Firebase není načtený (firebase compat + firestore).");
    }
    db = window.firebase.firestore();
  }

  async function createOrJoin(){
    nick = (inpNick.value || "").trim().slice(0,30);
    code = clampCode(inpCode.value);

    if(!nick){
      setStatus("Zadej přezdívku.");
      return;
    }
    if(code.length !== 5){
      setStatus("Zadej 5místný kód.");
      return;
    }

    localStorage.setItem("zpevnik_share_nick", nick);

    const ref = getSessionRef(code);

    // pokus: načíst session
    const snap = await ref.get();
    const t = now();

    if(!snap.exists){
      // nikdo není -> vytvoř HOST
      await ref.set({
        code,
        hostId: myId,
        hostNick: nick,
        createdAt: t,
        lastActive: t,
        generation: 1,
        state: getCurrentState ? (getCurrentState() || null) : null,
        closed: false
      }, { merge: true });

      await becomeHost(ref);
      return;
    }

    const data = snap.data() || {};
    const expired = isExpired(data);

    if(expired){
      // session je logicky mrtvá -> přepiš a staň se hostem (nová generace)
      const gen = (data.generation || 1) + 1;
      await ref.set({
        code,
        hostId: myId,
        hostNick: nick,
        createdAt: t,
        lastActive: t,
        generation: gen,
        state: getCurrentState ? (getCurrentState() || null) : null,
        closed: false
      }, { merge: true });

      // vyčistit klienty „logicky“: přepíšeme generation, klienti pak poznají, že nejsou v aktuální generaci
      await becomeHost(ref);
      return;
    }

    // existuje a není expirovaná -> staň se CLIENT a požádej o přijetí
    await becomeClient(ref, data.generation || 1);
  }

  function isExpired(sessionData){
    const last = sessionData.lastActive || sessionData.createdAt || 0;
    return (now() - last) > (TTL_MINUTES * 60 * 1000) || sessionData.closed === true;
  }

  async function becomeHost(ref){
    cleanupListeners();
    role = "host";
    paused = false;
    setBtnState("host");
    setStatus(`Jsi host. Kód: ${code}. Čekající uživatelé uvidíš níže.`);
    updateModalUI();

    // poslouchej klienty
    clientsUnsub = ref.collection("clients")
      .onSnapshot((qs) => {
        renderClientList(qs);
      }, (err) => {
        console.error(err);
        setStatus("Chyba při čtení klientů.");
      });

    // heartbeat
    startHeartbeat(ref);

    // broadcast změn, pokud chceš volat ručně z aplikace:
    // window.zpevnikShareBroadcast() atd.
  }

  async function becomeClient(ref, generation){
    cleanupListeners();
    role = "client";
    paused = false;
    setBtnState("client");
    setStatus("Žádost o připojení odeslána. Čekej na přijetí hostem…");
    updateModalUI();

    // zapsat žádost do clients/{myId}
    await ref.collection("clients").doc(myId).set({
      id: myId,
      nick,
      status: "waiting",  // waiting | approved | rejected | disconnected
      paused: false,
      joinedAt: now(),
      lastActive: now(),
      generation: generation
    }, { merge: true });

    // poslouchej svůj client doc
    clientUnsub = ref.collection("clients").doc(myId)
      .onSnapshot((s) => {
        if(!s.exists){
          // host to smazal
          leaveLocal("Host ukončil sdílení (nebo tě odpojil).");
          return;
        }
        const d = s.data() || {};
        if(d.generation !== generation){
          leaveLocal("Sdílení vypršelo a bylo vytvořeno znovu. Zadej kód znovu.");
          return;
        }
        if(d.status === "rejected"){
          leaveLocal("Host tě odmítl.");
          return;
        }
        if(d.status === "disconnected"){
          leaveLocal("Host tě odpojil.");
          return;
        }
        if(d.status === "approved"){
          setStatus(paused ? "Pauza – nepřepínám písně." : "Připojeno – sleduju hosta.");
          // fialová nebo oranžová
          setBtnState(paused ? "paused" : "client");
        }
      });

    // poslouchej session state (jen když approved a nepaused)
    hostUnsub = ref.onSnapshot((s) => {
      if(!s.exists){
        leaveLocal("Host ukončil sdílení.");
        return;
      }
      const d = s.data() || {};
      if(isExpired(d)){
        leaveLocal("Sdílení vypršelo (neaktivita).");
        return;
      }

      // jen když jsem approved
      // (status máme v client docu, ale pro jednoduchost si to přečteme lokálně z cache: řešíme tak, že applyState děláme jen pokud role=client a !paused)
      if(role === "client" && !paused && d.state && applyState){
        applyState(d.state);
      }
    });

    startHeartbeat(ref);
  }

  function renderClientList(qs){
    // Host UI: seznam klientů + akce
    const arr = [];
    qs.forEach(doc => arr.push(doc.data()));
    // seřadit: waiting první
    arr.sort((a,b)=>{
      const pa = (a.status==="waiting")?0:1;
      const pb = (b.status==="waiting")?0:1;
      return pa-pb || (a.joinedAt||0)-(b.joinedAt||0);
    });

    listEl.innerHTML = "";

    if(arr.length === 0){
      const div = document.createElement("div");
      div.className = "share-status";
      div.textContent = "Zatím nikdo není připojený.";
      listEl.appendChild(div);
      return;
    }

    arr.forEach(u=>{
      const row = document.createElement("div");
      row.className = "share-user";

      const left = document.createElement("div");
      const name = document.createElement("div");
      name.textContent = u.nick || u.id;
      const meta = document.createElement("small");
      meta.textContent = `${u.status || "?"}${u.paused ? " • pauza" : ""}`;
      left.appendChild(name);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "u-actions";

      if(u.status === "waiting"){
        const ok = document.createElement("button");
        ok.className = "ok";
        ok.textContent = "Přijmout";
        ok.onclick = () => hostApprove(u.id, true);
        const no = document.createElement("button");
        no.className = "no";
        no.textContent = "Odmítnout";
        no.onclick = () => hostApprove(u.id, false);
        actions.appendChild(ok);
        actions.appendChild(no);
      }else if(u.status === "approved"){
        const kick = document.createElement("button");
        kick.className = "no";
        kick.textContent = "Odpojit";
        kick.onclick = () => hostKick(u.id);
        actions.appendChild(kick);
      }else{
        const del = document.createElement("button");
        del.textContent = "Smazat z listu";
        del.onclick = () => hostDelete(u.id);
        actions.appendChild(del);
      }

      row.appendChild(left);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  async function hostApprove(clientId, accept){
    const ref = getSessionRef(code);
    if(accept){
      await ref.collection("clients").doc(clientId).set({
        status: "approved",
        lastActive: now()
      }, { merge: true });
    }else{
      await ref.collection("clients").doc(clientId).set({
        status: "rejected",
        lastActive: now()
      }, { merge: true });
    }
    await touch(ref);
  }

  async function hostKick(clientId){
    const ref = getSessionRef(code);
    await ref.collection("clients").doc(clientId).set({
      status: "disconnected",
      lastActive: now()
    }, { merge: true });
    await touch(ref);
  }

  async function hostDelete(clientId){
    const ref = getSessionRef(code);
    await ref.collection("clients").doc(clientId).delete();
    await touch(ref);
  }

  async function hostCloseAll(){
    const ref = getSessionRef(code);
    // označ session jako closed; klienti se odpojí sami
    await ref.set({ closed:true, lastActive: now() }, { merge:true });

    // pokus smazat klienty: bez Cloud Functions to nejde ideálně “rekurzivně” ve velkém,
    // ale když jich je málo, jde to:
    const qs = await ref.collection("clients").get();
    const batch = db.batch();
    qs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    await ref.delete().catch(()=>{});
    leaveLocal("Sdílení ukončeno. Kód je volný.");
  }

  async function clientPause(){
    if(role !== "client") return;
    paused = true;
    setBtnState("paused");
    updateModalUI();
    setStatus("Pauza – nepřepínám písně.");

    const ref = getSessionRef(code);
    await ref.collection("clients").doc(myId).set({ paused:true, lastActive: now() }, { merge:true });
    await touch(ref);
  }

  async function clientResume(){
    if(role !== "client") return;
    paused = false;
    setBtnState("client");
    updateModalUI();
    setStatus("Připojeno – sleduju hosta.");

    const ref = getSessionRef(code);
    await ref.collection("clients").doc(myId).set({ paused:false, lastActive: now() }, { merge:true });
    await touch(ref);
  }

  async function clientLeave(){
    const ref = getSessionRef(code);
    try{
      await ref.collection("clients").doc(myId).delete();
      await touch(ref);
    }catch(e){}
    leaveLocal("Odpojeno.");
  }

  function leaveLocal(msg){
    cleanupListeners();
    role = "none";
    paused = false;
    code = "";
    setBtnState("normal");
    updateModalUI();
    setStatus(msg || "");
  }

  function cleanupListeners(){
    if(hostUnsub){ hostUnsub(); hostUnsub = null; }
    if(clientUnsub){ clientUnsub(); clientUnsub = null; }
    if(clientsUnsub){ clientsUnsub(); clientsUnsub = null; }
    if(hbTimer){ clearInterval(hbTimer); hbTimer = null; }
  }

  async function touch(ref){
    // lastActive host session
    try{
      await ref.set({ lastActive: now() }, { merge: true });
    }catch(e){}
  }

  function startHeartbeat(ref){
    if(hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(async ()=>{
      try{
        if(role === "host"){
          await ref.set({ lastActive: now(), hostId: myId }, { merge:true });
        }else if(role === "client"){
          await ref.collection("clients").doc(myId).set({ lastActive: now() }, { merge:true });
          await ref.set({ lastActive: now() }, { merge:true });
        }
      }catch(e){}
    }, HEARTBEAT_MS);
  }

  // Host: volá se z aplikace při navigaci (otevření písně atd.)
  async function broadcastState(state){
    if(role !== "host") return;
    const ref = getSessionRef(code);
    await ref.set({ state: state || null, lastActive: now() }, { merge:true });
  }

  // ===========================
  // Veřejné API pro tvou appku
  // ===========================
  async function initSharing(opts){
    // opts:
    // - shareBtnId, shareModalId (nepovinné, default: shareBtn / shareModal)
    // - getState(): objekt stavu (songId apod.)
    // - applyState(state): provede přechod
    await ensureFirebase();

    myId = makeId();
    getCurrentState = opts && opts.getState ? opts.getState : null;
    applyState = opts && opts.applyState ? opts.applyState : null;

    const shareBtnId = (opts && opts.shareBtnId) || "shareBtn";
    const shareModalId = (opts && opts.shareModalId) || "shareModal";

    btnShare = document.getElementById(shareBtnId);
    modal = document.getElementById(shareModalId);

    if(!btnShare || !modal){
      console.warn("Sdílení: chybí #shareBtn nebo #shareModal");
      return;
    }

    inpNick = modal.querySelector("#shareNick");
    inpCode = modal.querySelector("#shareCode");
    btnJoin = modal.querySelector("#shareJoin");
    btnLeave = modal.querySelector("#shareLeave");
    btnPause = modal.querySelector("#sharePause");
    btnResume = modal.querySelector("#shareResume");
    btnClose = modal.querySelector("#shareClose");
    statusEl = modal.querySelector("#shareStatus");
    listWrap = modal.querySelector("#shareListWrap");
    listEl = modal.querySelector("#shareList");
    hostTools = modal.querySelector("#shareHostTools");

    // ochrany
    if(!inpNick || !inpCode || !btnJoin || !btnLeave || !btnPause || !btnResume || !btnClose || !statusEl || !listWrap || !listEl || !hostTools){
      console.warn("Sdílení: modal nemá očekávané prvky (id).");
      return;
    }

    // input kód
    inpCode.addEventListener("input", ()=>{
      inpCode.value = clampCode(inpCode.value);
    });

    btnShare.addEventListener("click", ()=>{
      // pokud už sdílím, otevř modal s možnostmi (host: správa/ukončit, client: pauza/odpojit)
      openModal();
    });

    btnClose.addEventListener("click", closeModal);
    modal.addEventListener("click", (e)=>{
      if(e.target === modal) closeModal();
    });

    btnJoin.addEventListener("click", async ()=>{
      try{
        setStatus("Připojuji…");
        await createOrJoin();
      }catch(err){
        console.error(err);
        setStatus("Nelze se připojit. Zkontroluj Firebase.");
      }
    });

    btnLeave.addEventListener("click", async ()=>{
      if(role === "host"){
        const ok = confirm("Opravdu zrušit sdílení? Odpojím všechny a kód bude volný.");
        if(ok) await hostCloseAll();
      }else if(role === "client"){
        const ok = confirm("Opravdu odpojit od hosta?");
        if(ok) await clientLeave();
      }
    });

    btnPause.addEventListener("click", async ()=>{
      await clientPause();
    });
    btnResume.addEventListener("click", async ()=>{
      await clientResume();
    });

    // uložit nick
    const storedNick = localStorage.getItem("zpevnik_share_nick");
    if(storedNick) inpNick.value = storedNick;

    updateModalUI();
    setBtnState("normal");
  }

  // vystavit do window
  window.ZPEVNIK_SHARING = {
    initSharing,
    broadcastState
  };
})();
