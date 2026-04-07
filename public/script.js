(function() {
  'use strict';

  const State = { 
    user: null, 
    editId: null, 
    takeId: null, 
    analysisId: null, 
    responses: [], 
    supabase: null,
    currentTakeForm: null,
    forms: [] // ✅ Cache forms for instant UI updates
  };
  window.State = State;

  const U = { 
    id: () => `q_${Date.now().toString(36)}${Math.random().toString(36).substr(2, 6)}`, 
    secId: () => `s_${Date.now().toString(36)}${Math.random().toString(36).substr(2, 4)}`, 
    esc: s => typeof s === 'string' ? new DOMParser().parseFromString(s, 'text/html').documentElement.textContent : '', 
    date: d => d ? new Date(d).toLocaleDateString() : '—', 
    uid: () => Math.random().toString(36).substr(2, 9) 
  };
  
  const Theme = { 
    init() { 
      const saved = localStorage.getItem('theme');
      const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
      this.set(saved || (prefersDark ? 'dark' : 'light')); 
    }, 
    set(t) { 
      document.documentElement.setAttribute('data-theme', t); 
      localStorage.setItem('theme', t); 
      const b = document.querySelector('[data-action="theme"]'); 
      if(b) b.innerHTML = t === 'dark' 
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"></path></svg>';
    }, 
    toggle() { 
      const current = document.documentElement.getAttribute('data-theme');
      this.set(current === 'dark' ? 'light' : 'dark'); 
    } 
  };

  const API = { 
    async fetch(url, opts={}) { 
      try { 
        const r = await fetch(url, { credentials:'include', headers:{'Content-Type':'application/json',...opts.headers}, ...opts }); 
        return await r.json(); 
      } catch { return {error:'Network error'}; } 
    }, 
    me() { return this.fetch('/api/auth/me'); }, 
    login(d) { return this.fetch('/api/auth/login', {method:'POST',body:JSON.stringify(d)}); }, 
    signup(d) { return this.fetch('/api/auth/signup', {method:'POST',body:JSON.stringify(d)}); }, 
    async logout() { await this.fetch('/api/auth/logout',{method:'POST'}); window.location.reload(); }, 
    getUsers() { return this.fetch('/api/admin/users'); }, 
    delUser(id) { return this.fetch(`/api/admin/users/${id}`, {method:'DELETE'}); } 
  };

  const DB = {
    async getForms() {
      if (!State.user || !State.supabase) return [];
      const { data, error } = await State.supabase.from('forms').select('*').eq('owner_id', State.user.id).order('updated_at', { ascending: false });
      // ✅ Cache forms in State for instant UI updates
      if (!error && data) State.forms = data;
      return error ? [] : (data || []);
    },
    async saveForm(form) {
      if (!State.supabase) return false;
      form.updated_at = new Date().toISOString();
      const { data, error } = await State.supabase.from('forms').upsert(form, { onConflict: 'id' });
      // ✅ Update cache on save
      if (!error && data) {
        const idx = State.forms.findIndex(f => f.id === form.id);
        if (idx >= 0) State.forms[idx] = { ...State.forms[idx], ...form };
        else State.forms.unshift(form);
      }
      return !error;
    },
    async deleteForm(id) {
      if (!State.supabase) return false;
      const { error } = await State.supabase.from('forms').delete().eq('id', id);
      // ✅ Remove from cache on delete
      if (!error) State.forms = State.forms.filter(f => f.id !== id);
      return !error;
    },
    async getResponses() {
      if (!State.user || !State.supabase) return [];
      const { data, error } = await State.supabase.from('responses').select('*').eq('form_owner_id', State.user.id);
      return error ? [] : (data || []);
    },
    async submitResponse(formId, answers) {
      if (!State.supabase) return false;
      const { error } = await State.supabase.from('responses').insert({
        id: U.id(), form_id: formId, form_owner_id: answers._ownerId, answers, submitted_at: new Date().toISOString()
      });
      return !error;
    },
    async importResponses(formId, responses) {
      if (!State.supabase || !responses.length) return false;
      const { error } = await State.supabase.from('responses').insert(responses.map(r => ({ ...r, form_id: formId, form_owner_id: State.user.id, submitted_at: r.submitted_at || new Date().toISOString() })));
      return !error;
    }
  };

  function toast(m, t='info') { 
    const c=document.getElementById('toasts'); if(!c) return; 
    const e=document.createElement('div'); e.className=`toast t-${t[0]}`; 
    e.innerHTML=`<span>${t==='success'?'✅':t==='error'?'❌':'ℹ️'}</span><span>${U.esc(m)}</span>`; 
    c.appendChild(e); setTimeout(()=>{e.style.opacity='0';setTimeout(()=>e.remove(),300)},3000); 
  }

  // ✅ GLOBAL HELPERS
  window.updateProgressBar = function(q) {
    if(!q || !q.sections) return;
    const total = q.sections.reduce((a,s)=>a+s.questions.length,0);
    let filled = 0;
    q.sections.forEach(sec=>{
      sec.questions.forEach((qn,i)=>{
        const n=`q${sec.id}_${i}`;
        if(qn.type === 'mc' || qn.type === 'rt') {
          if(document.querySelector(`[name="${n}"]:checked`)) filled++;
        } else if(qn.type === 'cb') {
          if(document.querySelectorAll(`[name="${n}"]:checked`).length > 0) filled++;
        } else {
          const el=document.querySelector(`[name="${n}"]`);
          if(el && el.value.trim() !== '') filled++;
        }
      });
    });
    const pct = total > 0 ? Math.round((filled/total)*100) : 0;
    const bar=document.getElementById('takeBar');
    const text=document.getElementById('progressPercent');
    if(bar) bar.style.width=`${pct}%`;
    if(text) text.textContent=`${pct}%`;
  };

  window.selectRating = function(btn, name) {
    document.querySelectorAll(`[data-name="${name}"]`).forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const input=document.getElementById(name);
    if(input) input.value=btn.dataset.v;
    const parent = btn.closest('.rating-row');
    if(parent) parent.querySelectorAll('.r-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    window.updateProgressBar(window.State?.currentTakeForm);
  };

  window.openResponseDetail = async function(id){
    const r = State.responses.find(x=>x.id===id); if(!r) return;
    const allForms = await DB.getForms(); const q = allForms.find(x=>x.id===r.form_id); if(!q) return;
    const c=document.getElementById('responseDetailContent'); let html='';
    q.sections.forEach(sec=>{
      html+=`<div class="detail-section"><h4>${U.esc(sec.title)}</h4>`;
      sec.questions.forEach((qn,i)=>{
        const ans = r.answers[`q${sec.id}_${i}`] || '—';
        html+=`<div style="margin-bottom:1rem"><small style="color:var(--text-2)">Q${i+1}. ${U.esc(qn.text)}</small><div class="detail-answer">${U.esc(Array.isArray(ans)?ans.join(', '):ans)}</div></div>`;
      }); html+=`</div>`;
    });
    c.innerHTML=html; document.getElementById('responseDetailModal').classList.add('active');
  };

  const UI = {
    authUI() { 
      const h=document.getElementById('appHeader'), n=document.getElementById('userName');
      const adminDesktop=document.getElementById('adminNav'), adminMobile=document.getElementById('adminNavMobile');
      if(!h) return; 
      if(State.user) { 
        h.classList.remove('hidden'); n.textContent=State.user.name.split(' ')[0]; 
        const isAdmin = State.user.role === 'admin';
        if(adminDesktop) adminDesktop.classList.toggle('hidden', !isAdmin);
        if(adminMobile) adminMobile.classList.toggle('hidden', !isAdmin);
      } else { h.classList.add('hidden'); } 
    },
    
    // ✅ FIXED: Properly await all data before rendering
    async initAuth() { 
      try { 
        const r = await API.me(); 
        if(r?.id) { 
          State.user = r; 
          // ✅ Await both forms and responses before proceeding
          const [forms, responses] = await Promise.all([
            DB.getForms(),
            DB.getResponses()
          ]);
          State.responses = responses;
          
          this.authUI(); 
          
          const hash = location.hash.replace('#','');
          if(['login','signup'].includes(hash)) { 
            history.replaceState(null,'','#home'); 
            return nav('home'); 
          }
          if(!hash) return nav('home');
          return true; 
        } 
      } catch(err) {
        console.error('Auth init error:', err);
      } 
      State.user=null; this.authUI(); 
      const hash=location.hash.replace('#',''); 
      if(!['login','signup','take'].includes(hash)) nav('login'); 
    },

    collect() {
      const title=document.getElementById('qTitle')?.value.trim(); if(!title) return null;
      const sections=[];
      document.querySelectorAll('.form-section').forEach(secEl=>{
        const secId=secEl.dataset.secId, secTitle=secEl.querySelector('.sec-title')?.value.trim()||'Section';
        const questions=[];
        secEl.querySelectorAll('.q-block').forEach(qEl=>{
          const txt=qEl.querySelector('.q-text')?.value.trim(); if(!txt) return;
          const type=qEl.querySelector('.q-type')?.value, req=qEl.querySelector('.toggle')?.classList.contains('active'), opts=[];
          if(['mc','cb','dd'].includes(type)) qEl.querySelectorAll('.opt-in').forEach(i=>{if(i.value.trim())opts.push(i.value.trim());});
          questions.push({text:txt,type,required:req,options:opts});
        });
        sections.push({id:secId,title:secTitle,questions});
      });
      return {id:State.editId||U.id(),title,description:document.getElementById('qDesc')?.value.trim()||'',category:'General',status:'draft',sections,owner_id:State.user?.id};
    },

    async save(pub) { 
      const q=this.collect(); 
      if(!q) return toast('Title required','error'); 
      const totalQ=q.sections.reduce((a,s)=>a+s.questions.length,0); 
      if(pub&&!totalQ) return toast('Add ≥1 question','error'); 
      q.status=pub?'active':'draft'; 
      toast('Syncing to cloud...','info');
      const success=await DB.saveForm(q);
      if(success) {
        State.editId=q.id;
        toast(pub?'Published!':'Draft saved!','success'); 
        const ls=document.getElementById('lastSave'); if(ls){ls.textContent='Saved: '+new Date().toLocaleTimeString();ls.style.display='inline';}
        if(pub) nav('my-forms'); 
      } else toast('Cloud sync failed','error');
    },

    renderCard(q) { 
      const rc=State.responses.filter(r=>r.form_id===q.id).length; 
      const totalQ=q.sections?q.sections.reduce((a,s)=>a+s.questions.length,0):0;
      return `<article class="card" data-form-id="${q.id}"><div class="card-head"><div><h4 class="card-title">${U.esc(q.title)}</h4><p class="card-desc">${U.esc(q.description||'')}</p></div><span class="badge ${q.status==='active'?'b-active':'b-draft'}">${q.status}</span></div><div class="meta"><span>❓ ${totalQ}</span><span>📝 ${rc}</span><span>📅 ${U.date(q.updated_at)}</span></div><div class="actions">${q.status==='active'?`<button class="btn-modern ghost" data-nav="take" data-id="${q.id}">📝 Take</button>`:''}<button class="btn-modern ghost" data-nav="analysis" data-id="${q.id}">📊 Analyze</button><button class="btn-modern ghost" data-nav="create" data-id="${q.id}">✏️ Edit</button><button class="btn-modern ghost" data-nav="share" data-id="${q.id}">🔗 Share</button><button class="btn-modern ghost danger" data-action="del-form" data-id="${q.id}">🗑️</button></div></article>`; 
    },
    
    // ✅ FIXED: Use cached forms + ensure data is loaded
    async home() { 
      // ✅ Ensure forms are loaded
      if (!State.forms || State.forms.length === 0) {
        await DB.getForms();
      }
      
      const qs = State.forms;
      const rs = State.responses;
      
      document.getElementById('statTotal').textContent = qs.length; 
      document.getElementById('statResponses').textContent = rs.length; 
      document.getElementById('statActive').textContent = qs.filter(q=>q.status==='active').length; 
      document.getElementById('statAvg').textContent = qs.length ? Math.round(rs.length/qs.length*10)/10 : 0; 
      
      const g = document.getElementById('recentGrid');
      const rec = [...qs].slice(0, 6); 
      
      if (rec.length) {
        g.innerHTML = rec.map(q => this.renderCard(q)).join('');
      } else {
        g.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><h3>No activity</h3><button class="btn-modern primary" data-nav="create">Create Form</button></div>`;
      }
    },
    
    // ✅ FIXED: Use cached forms + ensure data is loaded
    async myForms(f='all') { 
      if(!State.user) return nav('login'); 
      
      // ✅ Ensure forms are loaded
      if (!State.forms || State.forms.length === 0) {
        await DB.getForms();
      }
      
      let qs = State.forms;
      const t = document.getElementById('globalSearch')?.value.toLowerCase() || ''; 
      
      qs = qs.filter(q => 
        q.title.toLowerCase().includes(t) || 
        (q.description || '').toLowerCase().includes(t)
      ); 
      
      if(f !== 'all') qs = qs.filter(q => q.status === f); 
      
      const g = document.getElementById('myGrid'), e = document.getElementById('myEmpty'); 
      
      if(qs.length) { 
        g.innerHTML = qs.map(q => this.renderCard(q)).join(''); 
        g.classList.remove('hidden'); 
        e.classList.add('hidden'); 
      } else { 
        g.innerHTML = ''; 
        g.classList.add('hidden'); 
        e.classList.remove('hidden'); 
      } 
    },

    async initCreate(id) {
      State.editId = id || null; 
      const secC = document.getElementById('sectionsContainer'); 
      if(!secC) return; 
      secC.innerHTML = '';
      
      const t = document.getElementById('qTitle'); if(t) t.value = ''; 
      const d = document.getElementById('qDesc'); if(d) d.value = '';
      const s = document.getElementById('lastSave'); if(s) { s.textContent = 'Draft ready'; s.style.display = 'none'; }
      const p = document.getElementById('pageTitle'); if(p) p.textContent = id ? 'Edit Form' : 'New Form';
      const c = document.getElementById('catPills'); if(c) c.innerHTML = `<input type="hidden" id="qCat" value="General"><div class="pill active" data-cat="General">General</div>`;
      
      if(id){
        // ✅ Use cached forms first, fallback to fetch
        let q = State.forms.find(x => x.id === id);
        if (!q) {
          const allForms = await DB.getForms();
          q = allForms.find(x => x.id === id);
        }
        if(q){ 
          if(t) t.value = q.title; 
          if(d) d.value = q.description || ''; 
          if(q.sections && q.sections.length) q.sections.forEach(sec => this.addSection(sec)); 
          else this.addSection({title:'Section 1'}); 
        }
      } else { 
        this.addSection({title:'Section 1'}); 
      }
    },

    addSection(secData={}) {
      const secId = secData.id || U.secId(), secTitle = secData.title || 'New Section';
      const secEl = document.createElement('section'); 
      secEl.className = 'form-section'; 
      secEl.dataset.secId = secId;
      secEl.innerHTML = `<div class="sec-header"><input type="text" class="sec-title" value="${U.esc(secTitle)}" placeholder="Section Title"><button type="button" class="btn-modern ghost rm-sec"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg></button></div><div class="sec-questions"></div><button type="button" class="btn-modern ghost add-q-sec" style="width:100%;margin-top:8px"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>Add Question</button>`;
      document.getElementById('sectionsContainer').appendChild(secEl);
      if(secData.questions) secData.questions.forEach(q => this.addQuestion(secId, q));
      secEl.querySelector('.rm-sec').addEventListener('click', () => {
        if(document.querySelectorAll('.form-section').length > 1) { secEl.remove(); } 
        else toast('At least one section required', 'error');
      });
      secEl.querySelector('.add-q-sec').addEventListener('click', () => this.addQuestion(secId));
    },

    addQuestion(secId, d={}) {
      const uid = U.uid(), t = d.type || 'mc'; 
      const secEl = document.querySelector(`.form-section[data-sec-id="${secId}"]`);
      if(!secEl) return; 
      const qCont = secEl.querySelector('.sec-questions');
      const qEl = document.createElement('div'); 
      qEl.className = 'q-block'; 
      qEl.dataset.uid = uid;
      qEl.innerHTML = `<button type="button" class="close-q" style="position:absolute;top:12px;right:12px;background:none;border:none;color:var(--text-2);cursor:pointer;font-size:1.1rem;padding:4px">✕</button><div class="q-head"><span class="q-num">Question</span><div class="q-ctrl"><select class="q-type">${[['mc','Multiple Choice'],['cb','Checkbox'],['tx','Short Text'],['ta','Long Text'],['rt','Rating 1-5'],['dd','Dropdown']].map(o=>`<option value="${o[0]}" ${t===o[0]?'selected':''}>${o[1]}</option>`).join('')}</select><div class="toggle ${d.required?'active':''}" title="Required"></div></div></div><div class="field"><input type="text" class="q-text" value="${U.esc(d.text||'')}" placeholder="Enter question..." required></div><div class="opts" data-uid="${uid}">${this.opts(t, d.options)}</div>`;
      qCont.appendChild(qEl); 
      this.idx(); 
      qEl.querySelector('.close-q').addEventListener('click', () => { qEl.remove(); this.idx(); });
      qEl.querySelector('.q-type').addEventListener('change', e => { qEl.querySelector('.opts').innerHTML = this.opts(e.target.value); });
      qEl.querySelector('.toggle').addEventListener('click', e => { e.target.classList.toggle('active'); });
      setTimeout(() => {
        qEl.querySelectorAll('.opt-row').forEach(row => { row.querySelector('.rm-opt')?.addEventListener('click', () => { row.remove(); }); });
        qEl.querySelector('.add-opt')?.addEventListener('click', () => {
          const c = qEl.querySelector('.opts'), n = c.querySelectorAll('.opt-row').length + 1;
          c.insertAdjacentHTML('beforeend', `<div class="opt-row"><input type="text" class="opt-in" placeholder="Option ${n}"><button type="button" class="rm-opt" style="background:none;border:none;color:var(--danger);cursor:pointer;padding:4px">✕</button></div>`);
        });
      }, 0);
    },

    opts(t, o=[]) { 
      const opts = o.length ? o : ['Option 1', 'Option 2', 'Option 3']; 
      if(['mc','cb','dd'].includes(t)) return opts.map((v,i) => `<div class="opt-row"><input type="text" class="opt-in" value="${U.esc(v)}" placeholder="Option"><button type="button" class="rm-opt" style="background:none;border:none;color:var(--danger);cursor:pointer;padding:4px">✕</button></div>`).join('') + `<button type="button" class="btn-modern ghost add-opt" style="font-size:0.8rem;padding:4px 8px;margin-top:4px">+ Add Option</button>`; 
      if(t === 'rt') return `<p class="subtext">Respondents will rate 1-5</p>`; 
      return `<p class="subtext">Free text response</p>`; 
    },
    
    idx() { document.querySelectorAll('.q-block').forEach((el,i) => { const n = el.querySelector('.q-num'); if(n) n.textContent = `Question ${i+1}`; }); },

    async initTake(id) { 
      if(!id) return toast('Missing ID', 'error'); 
      State.takeId = id; 
      
      const qC = document.getElementById('takeQuestions');
      const sB = document.getElementById('submitBtn');
      const bar = document.getElementById('takeBar');
      const pct = document.getElementById('progressPercent');
      
      if(qC) qC.innerHTML = '<div class="subtext" style="text-align:center;padding:2rem">Loading questionnaire...</div>';
      if(sB) { 
        sB.disabled = false; 
        sB.innerHTML = '<span class="btn-text">Submit Response</span><span class="btn-glow"></span>';
        const newBtn = sB.cloneNode(true);
        sB.replaceWith(newBtn);
        newBtn.addEventListener('click', () => UI.submit(new Event('submit')));
      }
      if(bar) bar.style.width = '0%'; 
      if(pct) pct.textContent = '0%';
      
      try { 
        const {data, error} = await State.supabase.from('forms').select('*').eq('id', id).single();
        if(error || !data) throw new Error('Form not found'); 
        const q = data; 
        State.currentTakeForm = q;
        
        document.getElementById('takeInfo').innerHTML = `<h2>${U.esc(q.title)}</h2>${q.description ? `<p class="subtext">${U.esc(q.description)}</p>` : ''}`; 
        
        if(qC) { 
          let html = '';
          q.sections.forEach((sec, si) => {
            html += `<div class="sec-render" style="animation-delay:${si*0.1}s"><h3 class="sec-render-title">${U.esc(sec.title)}</h3>`;
            sec.questions.forEach((qn, i) => {
              const rq = qn.required ? 'required' : ''; 
              let h = ''; 
              const name = `q${sec.id}_${i}`;
              
              switch(qn.type){
                case 'mc': 
                  h = qn.options.map(o => `<label class="r-label" data-group="${name}"><input type="radio" name="${name}" value="${U.esc(o)}" ${rq}><span>${U.esc(o)}</span></label>`).join(''); 
                  break;
                case 'cb': 
                  h = qn.options.map(o => `<label class="c-label"><input type="checkbox" name="${name}" value="${U.esc(o)}"><span>${U.esc(o)}</span></label>`).join(''); 
                  break;
                case 'tx': h = `<input type="text" name="${name}" placeholder="Type your answer..." ${rq}>`; break;
                case 'ta': h = `<textarea name="${name}" placeholder="Write your thoughts here..." ${rq}></textarea>`; break;
                case 'rt': 
                  h = `<div class="rating-row">${[1,2,3,4,5].map(n => `<button type="button" class="r-btn" data-v="${n}" data-name="${name}">${n}</button>`).join('')}<input type="hidden" name="${name}" id="${name}" ${rq}></div>`; 
                  break;
                case 'dd': 
                  h = `<select name="${name}" ${rq}><option value="">Choose...</option>${qn.options.map(o => `<option value="${U.esc(o)}">${U.esc(o)}</option>`).join('')}</select>`; 
                  break;
              }
              html += `<div class="t-q"><h4><span class="q-mark">${i+1}.</span> ${U.esc(qn.text)} ${qn.required ? '<span class="req">*</span>' : ''}</h4>${h}</div>`;
            });
            html += '</div>';
          });
          qC.innerHTML = html;
          
          setTimeout(() => {
            const container = document.getElementById('takeQuestions');
            if(!container) return;
            container.querySelectorAll('input[type="text"], textarea, select').forEach(el => {
              el.addEventListener('input', () => window.updateProgressBar(State.currentTakeForm));
              el.addEventListener('change', () => window.updateProgressBar(State.currentTakeForm));
            });
            container.querySelectorAll('input[type="radio"]').forEach(radio => {
              radio.addEventListener('change', function(){
                const label = this.closest('.r-label');
                if(label){
                  const name = this.name;
                  container.querySelectorAll(`.r-label[data-group="${name}"]`).forEach(l => l.classList.remove('selected'));
                  label.classList.add('selected');
                }
                window.updateProgressBar(State.currentTakeForm);
              });
            });
            container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
              cb.addEventListener('change', function(){
                const label = this.closest('.c-label');
                if(label) label.classList.toggle('selected');
                window.updateProgressBar(State.currentTakeForm);
              });
            });
            container.querySelectorAll('.rating-row .r-btn').forEach(btn => {
              btn.addEventListener('click', function(){
                window.selectRating(this, this.dataset.name);
              });
            });
          }, 100);
        }
      } catch(e) { 
        console.error('InitTake Error:', e);
        if(qC) qC.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Form Unavailable</h3><p>${e.message}</p></div>`; 
      } 
    },

    async submit(e) { 
      if(e) e.preventDefault();
      
      const fId = State.takeId;
      const sB = document.getElementById('submitBtn');
      
      if(!fId) {
        toast('Form ID missing', 'error');
        return;
      }
      
      if(sB) {
        sB.disabled = true;
        sB.innerHTML = '<span class="spinner"></span><span class="btn-text">Submitting...</span>';
      }
      
      try { 
        const {q, error:fetchError} = await State.supabase.from('forms').select('*').eq('id', fId).single();
        
        if(fetchError || !q) {
          throw new Error('Form expired or not found');
        }
        
        const answers = {_ownerId: q.owner_id};
        let validationError = null;
        
        for(const sec of q.sections){
          for(const[i, qn] of sec.questions.entries()){
            const n = `q${sec.id}_${i}`;
            
            if(qn.type === 'cb') {
              answers[n] = [...document.querySelectorAll(`[name="${n}"]:checked`)].map(c => c.value);
            } else if(qn.type === 'rt') {
              answers[n] = document.getElementById(n)?.value || '';
            } else {
              const el = document.querySelector(`[name="${n}"]`);
              if(el) {
                if(el.tagName === 'SELECT') {
                  answers[n] = el.value;
                } else if(el.type === 'radio') {
                  answers[n] = document.querySelector(`[name="${n}"]:checked`)?.value || '';
                } else {
                  answers[n] = el.value;
                }
              } else {
                answers[n] = '';
              }
            }
            
            if(qn.required) {
              const val = answers[n];
              if(!val || (Array.isArray(val) && val.length === 0)) {
                validationError = `Please answer: "${qn.text}"`;
                break;
              }
            }
          }
          if(validationError) break;
        }
        
        if(validationError) {
          throw new Error(validationError);
        }
        
        const success = await DB.submitResponse(fId, answers);
        
        if(!success) {
          throw new Error('Failed to save response');
        }
        
        const wrapper = document.querySelector('.take-form-wrapper');
        const submitWrapper = document.querySelector('.submit-wrapper');
        
        if(wrapper) {
          wrapper.innerHTML = `
            <div class="success-state">
              <div class="success-icon">🎉</div>
              <h2>Thank You!</h2>
              <p class="subtext">Your response has been recorded successfully.</p>
              <button class="btn-modern primary" style="margin-top:1.5rem;padding:14px 28px;font-size:1rem" onclick="window.location.href='#home'">
                ← Return to Homepage
              </button>
            </div>
          `;
        }
        if(submitWrapper) {
          submitWrapper.style.display = 'none';
        }
        
        toast('Response submitted!', 'success');
        
      } catch(err) { 
        console.error('Submit error:', err);
        toast(err.message || 'Submission failed', 'error');
        
        if(sB) {
          sB.disabled = false;
          sB.innerHTML = '<span class="btn-text">Submit Response</span><span class="btn-glow"></span>';
        }
      } 
    },

    async initAnalysis(id) { 
      if(!id) return toast('Missing ID', 'error'); 
      State.analysisId = id; 
      
      const cont = document.getElementById('analysisContent');
      const list = document.getElementById('responsesList');
      const ai = document.getElementById('analysisAI');
      
      if(cont) cont.innerHTML = '';
      if(list) list.innerHTML = '';
      if(ai) ai.innerHTML = '';
      
      // ✅ Ensure responses are loaded
      if (!State.responses || State.responses.length === 0) {
        State.responses = await DB.getResponses();
      }
      
      // ✅ Use cached forms
      let allForms = State.forms;
      if (!allForms || allForms.length === 0) {
        allForms = await DB.getForms();
      }
      
      const q = allForms.find(x => x.id === id);
      
      if(!q) return nav('my-forms'); 
      
      const head = document.getElementById('analysisHead'); 
      if(head) head.innerHTML = `<h2>${U.esc(q.title)}</h2>`; 
      
      const filterDays = parseInt(document.getElementById('dateFilter')?.value || 'all');
      const now = new Date();
      
      const filteredRs = State.responses.filter(r => {
        if (r.form_id !== id) return false;
        if(filterDays === 'all') return true;
        const d = new Date(r.submitted_at);
        return !isNaN(d) && (now - d) < (filterDays * 24 * 60 * 60 * 1000);
      });
      
      console.log(`📊 Analysis: Found ${filteredRs.length} responses for form ${id}`);
      
      const emp = document.getElementById('analysisEmpty');
      if(filteredRs.length === 0){ 
        if(emp) emp.classList.remove('hidden'); 
        const s = document.getElementById('analysisSummary'); if(s) s.innerHTML = '';
        if(cont) cont.classList.add('hidden'); 
        if(list) list.classList.add('hidden');
        if(ai) ai.classList.add('hidden');
        return; 
      } 
      if(emp) emp.classList.add('hidden'); 
      if(ai) ai.classList.remove('hidden');
      
      const summary = document.getElementById('analysisSummary');
      const avgRating = this.calculateAvgRating(q, filteredRs);
      if(summary){
        summary.innerHTML = `
          <div class="summary-card"><div class="summary-val">${filteredRs.length}</div><div class="summary-lbl">Responses</div></div>
          <div class="summary-card"><div class="summary-val">${q.sections.reduce((a,s)=>a+s.questions.length,0)}</div><div class="summary-lbl">Questions</div></div>
          ${avgRating > 0 ? `<div class="summary-card"><div class="summary-val">${avgRating.toFixed(1)}★</div><div class="summary-lbl">Avg Rating</div></div>` : ''}
          <div class="summary-card"><div class="summary-val" style="font-size:1rem; margin-top:8px">${U.date(filteredRs[0]?.submitted_at)}</div><div class="summary-lbl">Latest</div></div>
        `;
      }
      
      if(ai){
        ai.innerHTML = `
          <button class="btn-modern primary" id="aiAnalyzeBtn" style="width:100%;margin-bottom:1rem">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10H12V2z"></path><path d="M20.66 10.66a8 8 0 0 0-1.32-4.34L20 7a10 10 0 0 0-4.34 1.32L20 10.66z"></path><path d="M10.66 20.66a8 8 0 0 0 4.34-1.32L15 18a10 10 0 0 0-1.32-4.34L10.66 20.66z"></path></svg>
            Generate AI Insights
          </button>
          <div id="analysisAIContent"></div>
        `;
        
        document.getElementById('aiAnalyzeBtn')?.addEventListener('click', async () => {
           const c = document.getElementById('analysisAIContent'); 
           if(c) c.innerHTML = '<p class="subtext">Analyzing...</p>';
           try{
             const allQ = q.sections.flatMap(s => s.questions);
             const r = await fetch('/api/ai/analyze', {
               method:'POST',
               headers:{'Content-Type':'application/json'},
               body:JSON.stringify({
                 title:q.title,
                 questions:allQ,
                 responses:filteredRs,
                 responseCount:filteredRs.length
               })
             });
             const d = await r.json();
             if(d.error) throw new Error(d.error);
             const a = d.analysis;
             if(c){
               c.innerHTML = `
                 <div class="ai-grid">
                   <div class="ai-card"><h4>Summary</h4><p>${U.esc(a.summary)}</p></div>
                   <div class="ai-card"><h4>Sentiment</h4><span class="sent-badge s-${a.sentiment}">${a.sentiment.toUpperCase()}</span></div>
                   <div class="ai-card"><h4>Themes</h4><ul>${a.keyThemes.map(t=>`<li>${U.esc(t)}</li>`).join('')}</ul></div>
                   <div class="ai-card"><h4>Recommendations</h4><ul>${a.recommendations.map(rec=>`<li>${U.esc(rec)}</li>`).join('')}</ul></div>
                 </div>
               `;
             }
           }catch(err){
             if(c) c.innerHTML = `<p class="msg error">❌ ${err.message}</p>`;
           }
        });
      }
      
      const setupTabs = () => {
        document.querySelectorAll('.tab-btn').forEach(btn => {
          btn.replaceWith(btn.cloneNode(true));
        });
        
        document.querySelectorAll('.tab-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const tab = btn.dataset.tab;
            
            if(cont) {
              if(tab === 'charts'){
                cont.classList.remove('hidden');
                this.renderCharts(cont, q, filteredRs);
              } else {
                cont.classList.add('hidden');
              }
            }
            if(list) {
              if(tab === 'responses'){
                list.classList.remove('hidden');
                this.renderRawList(list, filteredRs);
              } else {
                list.classList.add('hidden');
              }
            }
          });
        });
      };
      
      setupTabs();
      
      if(cont) this.renderCharts(cont, q, filteredRs);
    },

    calculateAvgRating(q, rs){
      let total = 0, count = 0;
      q.sections.forEach(sec => {
        sec.questions.forEach((qn, i) => {
          if(qn.type === 'rt') rs.forEach(r => {
            const v = Number(r.answers[`q${sec.id}_${i}`]);
            if(!isNaN(v)){ total += v; count++; }
          });
        });
      });
      return count ? total/count : 0;
    },

    renderCharts(cont, q, rs){
      if(!cont) return; 
      cont.innerHTML = '';
      
      q.sections.forEach(sec => {
        sec.questions.forEach((qn, i) => {
          if(!['mc','cb','dd'].includes(qn.type)) return;
          
          const vals = rs.map(r => r.answers[`q${sec.id}_${i}`]).filter(v => v !== undefined && v !== '');
          if(vals.length === 0) return;
          
          const cts = {};
          (qn.options || []).forEach(o => cts[o] = 0);
          vals.forEach(v => Array.isArray(v) ? v.forEach(x => cts[x]++) : cts[v]++);
          
          const total = vals.length;
          const colors = ['#6366F1','#10B981','#EF4444','#F59E0B','#8B5CF6','#3B82F6'];
          
          let g = 'conic-gradient(', deg = 0, l = '';
          
          Object.entries(cts).forEach(([opt, cnt], idx) => {
            if(cnt === 0) return;
            const d = (cnt/total)*360;
            const col = colors[idx % colors.length];
            g += `${col} ${deg}deg ${deg+d}deg, `;
            l += `<div class="legend-item"><span><span class="legend-color" style="background:${col}"></span>${U.esc(opt)}</span><span>${cnt} (${Math.round((cnt/total)*100)}%)</span></div>`;
            deg += d;
          });
          g = g.slice(0, -2) + ')';
          
          cont.innerHTML += `
            <div class="chart-container">
              <h4 style="width:100%;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0.5rem">
                Q${i+1}. ${U.esc(qn.text)}
              </h4>
              <div class="donut-wrapper">
                <div class="donut" style="background:${g}">
                  <div class="donut-hole">
                    <span class="pct">${total}</span>
                    <span class="lbl">Total</span>
                  </div>
                </div>
              </div>
              <div class="donut-legend">${l}</div>
            </div>
          `;
        });
      });
    },

    renderRawList(list, rs){
      if(!list) return; 
      list.innerHTML = '';
      
      if(rs.length === 0){
        list.innerHTML = '<p class="subtext" style="text-align:center;padding:2rem">No responses to display</p>';
        return;
      }
      
      [...rs].reverse().forEach(r => {
        list.innerHTML += `
          <div class="response-item" onclick="openResponseDetail('${r.id}')">
            <div>
              <strong>Response</strong><br>
              <span class="resp-meta">📅 ${new Date(r.submitted_at).toLocaleString()}</span>
            </div>
            <div class="btn-modern ghost">👁️ View</div>
          </div>
        `;
      });
    },

    exportCSV() { 
      try {
        const q = State.forms.find(x => x.id === State.analysisId);
        if(!q) { toast('Form not found', 'error'); return; }
        
        const allQ = q.sections.flatMap(s => s.questions);
        const hd = ['ID','Date',...allQ.map((_,i) => `Q${i+1}`)];
        
        const rows = State.responses
          .filter(r => r.form_id === State.analysisId)
          .map((r,i) => [
            r.id.substring(0,8), 
            new Date(r.submitted_at).toLocaleString(), 
            ...allQ.map((_,j) => {
              const sec = q.sections.find(s => s.questions.some(qn => qn === allQ[j]));
              const n = sec ? `q${sec.id}_${j}` : '';
              let v = r.answers[n] || '';
              if(Array.isArray(v)) v = v.join('; ');
              return v;
            })
          ]);
        
        const csvContent = [
          '\uFEFF' + hd.join(','),
          ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], {type:'text/csv;charset=utf-8;'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${q.title.replace(/[^a-z0-9]/gi, '_')}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Exported CSV', 'success');
      } catch(err) {
        console.error('CSV Export Error:', err);
        toast('Export failed: ' + err.message, 'error');
      }
    },

    exportPDF() { 
      try {
        if(!window.jspdf) {
          toast('PDF library not loaded', 'error');
          return;
        }
        
        const q = State.forms.find(x => x.id === State.analysisId);
        if(!q) { toast('Form not found', 'error'); return; }
        
        const allQ = q.sections.flatMap(s => s.questions);
        const doc = new window.jspdf.jsPDF();
        
        doc.setFontSize(18); 
        doc.text(q.title, 14, 20); 
        doc.setFontSize(10);
        doc.text(`Responses: ${State.responses.filter(r => r.form_id === State.analysisId).length}`, 14, 28);
        
        const body = State.responses
          .filter(r => r.form_id === State.analysisId)
          .map((r,i) => [
            i+1, 
            new Date(r.submitted_at).toLocaleDateString(), 
            ...allQ.map((_,j) => {
              const sec = q.sections.find(s => s.questions.some(qn => qn === allQ[j]));
              const n = sec ? `q${sec.id}_${j}` : '';
              let v = r.answers[n] || '';
              if(Array.isArray(v)) v = v.join(', ');
              return v;
            })
          ]);
        
        doc.autoTable({
          head: [['#','Date',...allQ.map((_,i) => `Q${i+1}`)]],
          body,
          startY: 35,
          theme: 'grid',
          styles: { fontSize: 8, cellPadding: 2 }
        });
        
        doc.save(`${q.title.replace(/[^a-z0-9]/gi, '_')}.pdf`);
        toast('Exported PDF', 'success');
      } catch(err) {
        console.error('PDF Export Error:', err);
        toast('Export failed: ' + err.message, 'error');
      }
    },

    importCSV() { 
      const m = document.getElementById('importModal'); if(m) m.classList.add('active'); 
      const s1 = document.getElementById('importStep1'); if(s1) s1.classList.remove('hidden'); 
      const s2 = document.getElementById('importStep2'); if(s2) s2.classList.add('hidden'); 
      this.setupImport();
    },

    setupImport() {
      const dz = document.getElementById('dropZone'), inp = document.getElementById('csvFile'); 
      if(dz){
        dz.onclick = () => { if(inp) inp.click(); };
        dz.ondragover = e => { e.preventDefault(); dz.classList.add('dragover'); };
        dz.ondragleave = () => dz.classList.remove('dragover');
        dz.ondrop = e => {
          e.preventDefault();
          dz.classList.remove('dragover');
          if(inp && e.dataTransfer.files.length) {
            inp.files = e.dataTransfer.files;
            this.handleFile(inp.files[0]);
          }
        };
      }
      if(inp) inp.onchange = e => { if(e.target.files.length) this.handleFile(e.target.files[0]); };
    },

    handleFile(f) { 
      if(!f.name.endsWith('.csv')) return toast('Only CSV files allowed', 'error'); 
      const r = new FileReader();
      r.onload = e => {
        try{
          const {headers, rows} = this.parseCSV(e.target.result);
          if(!rows.length) throw new Error('Empty CSV');
          State.importData = {headers, rows};
          this.mapCSV();
        }catch(err){ toast(err.message, 'error'); }
      };
      r.readAsText(f); 
    },

    mapCSV() { 
      const q = State.forms.find(x => x.id === State.analysisId); if(!q) return;
      const c = document.getElementById('mapBox'); if(!c) return; c.innerHTML = ''; 
      const allQ = q.sections.flatMap(s => s.questions);
      allQ.forEach((qn, i) => {
        const opts = State.importData.headers.map(h => `<option value="${h}">${h}</option>`).join('');
        c.innerHTML += `<div class="opt-row"><span>Q${i+1}</span><select data-idx="${i}" class="field-select"><option value="">Skip</option>${opts}</select></div>`;
      });
      const s1 = document.getElementById('importStep1'), s2 = document.getElementById('importStep2');
      if(s1) s1.classList.add('hidden');
      if(s2) s2.classList.remove('hidden');
    },

    confirmImport() { 
      const q = State.forms.find(x => x.id === State.analysisId); if(!q) return;
      const maps = [...document.querySelectorAll('#mapBox select')].map(s => ({i: parseInt(s.dataset.idx), col: s.value})).filter(m => m.col);
      if(!maps.length) return toast('Map at least 1 column', 'error');
      
      const newR = State.importData.rows.map(row => {
        const res = {}; 
        maps.forEach(m => {
          const v = row[m.col];
          if(v && v !== '') {
            res[m.i] = v.includes(';') ? v.split(';').map(x => x.trim()) : v;
          }
        });
        return {id: U.id(), answers: res, submitted_at: new Date().toISOString()};
      }).filter(r => Object.keys(r.answers).length > 0);
      
      if(newR.length) {
        DB.importResponses(q.id, newR).then(ok => {
          if(ok) { 
            toast(`Imported ${newR.length} responses`, 'success'); 
            document.getElementById('importModal')?.classList.remove('active'); 
            this.initAnalysis(State.analysisId); 
          } else {
            toast('Import failed', 'error');
          }
        });
      } else {
        toast('No data to import', 'error');
      }
    },

    parseCSV(text) { 
      const lines = text.split(/\r?\n/).filter(l => l.trim()); 
      if(lines.length < 2) throw new Error('Invalid CSV'); 
      const h = this.parseLine(lines[0]); 
      const rows = []; 
      for(let i = 1; i < lines.length; i++){
        const c = this.parseLine(lines[i]);
        if(c.length === h.length) rows.push(Object.fromEntries(h.map((x, j) => [x, c[j]])));
      } 
      return {headers: h, rows}; 
    },
    
    parseLine(line) { 
      const res = []; let cur = '', q = false; 
      for(let i = 0; i < line.length; i++){
        const c = line[i];
        if(c === '"') q = !q;
        else if(c === ',' && !q) { res.push(cur.trim()); cur = ''; }
        else cur += c;
      } 
      res.push(cur.trim()); 
      return res; 
    },

    admin() { 
      if(State.user?.role !== 'admin') return nav('home');
      const t = document.getElementById('adminBody'); if(!t) return;
      t.innerHTML = '<tr><td colspan="5" class="text-center">Loading users...</td></tr>';
      API.getUsers().then(users => {
        if(!users || users.length === 0){ 
          t.innerHTML = '<tr><td colspan="5" class="text-center">No registered users found.</td></tr>'; 
          return; 
        }
        t.innerHTML = users.map(u => `
          <tr>
            <td>${U.esc(u.name)}</td>
            <td>${U.esc(u.email)}</td>
            <td><span class="badge ${u.role === 'admin' ? 'b-active' : 'b-draft'}">${u.role}</span></td>
            <td>${U.date(u.createdAt)}</td>
            <td>${u.role !== 'admin' && u.id !== State.user.id ? `<button class="del-btn" data-action="del-user" data-id="${u.id}">Delete</button>` : '<em>System</em>'}</td>
          </tr>
        `).join('');
      }).catch(err => { 
        console.error('Admin load error:', err);
        t.innerHTML = '<tr><td colspan="5" class="text-center" style="color:var(--danger)">Failed to load users</td></tr>'; 
      });
    },

    async profile() { 
      if(!State.user) return nav('login'); 
      document.getElementById('profAvatar').textContent = State.user.name[0].toUpperCase(); 
      document.getElementById('profName').textContent = State.user.name; 
      document.getElementById('profEmail').textContent = State.user.email; 
      document.getElementById('profRole').textContent = State.user.role; 
      document.getElementById('profDate').textContent = U.date(State.user.createdAt); 
      
      // ✅ Ensure forms are loaded for profile stats
      if (!State.forms || State.forms.length === 0) {
        await DB.getForms();
      }
      
      const forms = State.forms;
      document.getElementById('profForms').textContent = forms.length; 
      document.getElementById('profStorage').textContent = `${(JSON.stringify(forms).length/1024).toFixed(1)} KB`; 
    },

    initShare(id) { 
      if(!id) return; 
      const l = `${window.location.origin}${window.location.pathname}?take=${id}`; 
      const ln = document.getElementById('shareLink'); if(ln) ln.value = l; 
      const qr = document.getElementById('qrImg'); 
      if(qr){
        qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=10&data=${encodeURIComponent(l)}`;
        qr.onerror = () => {
          qr.style.display = 'none';
          qr.insertAdjacentHTML('afterend', `<p class="subtext">QR unavailable offline</p>`);
        };
      }
    },
    
    copy() { 
      try{
        const el = document.getElementById('shareLink');
        if(el){
          el.select();
          navigator.clipboard.writeText(el.value);
          toast('Copied!', 'success');
        }
      }catch{ toast('Copy failed', 'error'); } 
    },
    
    // ✅ FIXED: Delete form with immediate UI update
    async delForm(id) { 
      if(!confirm('Delete form & responses?')) return; 
      
      // ✅ Show loading state
      toast('Deleting...', 'info');
      
      try {
        const success = await DB.deleteForm(id);
        
        if(success) {
          // ✅ Remove card from DOM immediately
          const card = document.querySelector(`.card[data-form-id="${id}"]`);
          if(card) {
            card.style.transition = 'opacity 0.3s, transform 0.3s';
            card.style.opacity = '0';
            card.style.transform = 'translateY(-10px)';
            setTimeout(() => card.remove(), 300);
          }
          
          toast('Deleted', 'success');
          
          // ✅ Update stats if on home page
          if(location.hash === '#home') {
            await UI.home();
          }
          // ✅ Update list if on my-forms page
          else if(location.hash === '#my-forms') {
            await UI.myForms();
          }
        } else {
          toast('Delete failed', 'error');
        }
      } catch(err) {
        console.error('Delete error:', err);
        toast('Delete failed: ' + err.message, 'error');
      }
    },
    
    preview() { 
      const t = document.getElementById('qTitle')?.value.trim() || 'Untitled',
            d = document.getElementById('qDesc')?.value.trim() || ''; 
      let h = `<div style="text-align:center;margin-bottom:2rem"><h2>${U.esc(t)}</h2><p class="subtext">${U.esc(d)}</p></div>`; 
      document.querySelectorAll('.form-section').forEach(sec => {
        h += `<h3 style="color:var(--primary);margin:1rem 0 0.5rem">${U.esc(sec.querySelector('.sec-title').value)}</h3>`; 
        sec.querySelectorAll('.q-block').forEach((el, i) => {
          const txt = el.querySelector('.q-text')?.value.trim();
          if(!txt) return;
          const type = el.querySelector('.q-type')?.value,
                opts = [...el.querySelectorAll('.opt-in')].map(o => o.value).filter(Boolean);
          let inp = ''; 
          if(['mc','cb'].includes(type)) {
            inp = opts.map(o => `<label class="r-label" style="opacity:0.6;pointer-events:none"><input type="radio" disabled><span>${U.esc(o)}</span></label>`).join('');
          } else if(type === 'tx') {
            inp = '<input type="text" class="field" disabled>';
          } else if(type === 'rt') {
            inp = `<div style="opacity:0.5">${[1,2,3,4,5].map(n => `<span class="r-btn" style="width:28px;height:28px;line-height:28px">${n}</span>`).join('')}</div>`;
          } else {
            inp = '<textarea class="field" disabled></textarea>';
          }
          h += `<div class="t-q" style="margin-bottom:1rem"><h4><span class="q-mark">${i+1}.</span> ${U.esc(txt)}</h4>${inp}</div>`; 
        }); 
      }); 
      const c = document.getElementById('previewContent');
      if(c) c.innerHTML = h; 
      document.getElementById('previewModal')?.classList.add('active'); 
    },
  };

  function nav(p, args = {}) { 
    if(!['login','signup','take'].includes(p) && !State.user) return nav('login'); 
    
    // ✅ Ensure data is loaded before rendering pages
    if(['home','my-forms','analysis'].includes(p) && State.user) {
      // Only fetch if not already loaded
      if(!State.forms || State.forms.length === 0) {
        DB.getForms();
      }
      if(!State.responses || State.responses.length === 0) {
        DB.getResponses();
      }
    }
    
    document.querySelectorAll('.page').forEach(el => {
      el.classList.remove('active');
      el.style.opacity = '0';
      el.style.transform = 'translateY(12px)';
    }); 
    const t = document.getElementById(`page-${p}`); 
    if(t){
      t.classList.add('active');
      setTimeout(() => {
        t.style.opacity = '1';
        t.style.transform = 'translateY(0)';
      }, 10);
    } 
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active')); 
    document.querySelectorAll(`.nav-item[data-nav="${p}"]`).forEach(el => el.classList.add('active'));
    const sb = document.getElementById('searchBox'); 
    if(sb){
      if(p === 'my-forms'){
        sb.classList.remove('hidden');
        const si = document.getElementById('globalSearch');
        if(si) si.value = '';
        document.querySelectorAll('.f-btn').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
      } else {
        sb.classList.add('hidden');
      }
    } 
    switch(p){
      case 'login':break;
      case 'signup':break;
      case 'home': UI.home(); break;
      case 'my-forms': UI.myForms(); break;
      case 'create': UI.initCreate(args.id); break;
      case 'take': UI.initTake(args.id); break;
      case 'analysis': UI.initAnalysis(args.id); break;
      case 'share': UI.initShare(args.id); break;
      case 'admin': UI.admin(); break;
      case 'profile': UI.profile(); break;
    } 
    history.pushState({p}, '', `#${p}`); 
    window.scrollTo({top:0, behavior:'smooth'}); 
  }

  // ==================== BOOTSTRAP & EVENTS ====================
  document.addEventListener('DOMContentLoaded', async () => {
    Theme.init(); 
    
    // Load Supabase config
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const config = await res.json();
      
      console.log('Supabase Config:', { 
        url: config.supabaseUrl ? '✅ Set' : '❌ Missing', 
        key: config.supabaseKey ? '✅ Set' : '❌ Missing' 
      });
      
      if (!config.supabaseUrl || !config.supabaseKey) {
        throw new Error('SUPABASE_URL or SUPABASE_KEY missing in .env');
      }
      
      State.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
    } catch (e) { 
      console.error('Supabase Config Error:', e); 
      toast('Config Error: Check console & .env file', 'error'); 
      return; 
    }

    // ✅ FIXED: Await auth init completely before proceeding
    await UI.initAuth();

    // Mobile Drawer
    const hamburger = document.getElementById('hamburgerBtn'), 
          drawer = document.getElementById('mobileDrawer'), 
          closeDrawer = document.getElementById('closeDrawerBtn'), 
          backdrop = document.getElementById('drawerBackdrop');
    
    function openDrawer(){ drawer?.classList.add('open'); backdrop?.classList.add('open'); }
    function closeDrawerFn(){ drawer?.classList.remove('open'); backdrop?.classList.remove('open'); }
    
    hamburger?.addEventListener('click', openDrawer);
    closeDrawer?.addEventListener('click', closeDrawerFn);
    backdrop?.addEventListener('click', closeDrawerFn);

    // Global Click Handler
    document.addEventListener('click', async e => { 
      const navBtn = e.target.closest('[data-nav]');
      const actionBtn = e.target.closest('[data-action]');
      
      if(navBtn) { 
        e.preventDefault(); 
        closeDrawerFn(); 
        nav(navBtn.dataset.nav, { id: navBtn.dataset.id }); 
        return; 
      } 
      
      if(actionBtn) {
        e.preventDefault();
        const a = actionBtn.dataset.action, id = actionBtn.dataset.id;
        try {
          switch(a){
            case 'theme': Theme.toggle(); break;
            case 'logout': API.logout(); break;
            case 'add-sec': UI.addSection({title: `Section ${document.querySelectorAll('.form-section').length + 1}`}); break;
            case 'publish': await UI.save(true); break;
            case 'save-draft': await UI.save(false); break;
            case 'preview': UI.preview(); break;
            case 'close-modal': document.getElementById('previewModal')?.classList.remove('active'); break;
            case 'close-import': document.getElementById('importModal')?.classList.remove('active'); break;
            case 'close-response': document.getElementById('responseDetailModal')?.classList.remove('active'); break;
            case 'close-ai-gen': document.getElementById('aiGenModal')?.classList.remove('active'); break;
            case 'close-ai-analyze': document.getElementById('aiAnalyzeModal')?.classList.remove('active'); break;
            case 'import': UI.importCSV(); break;
            case 'confirm-import': UI.confirmImport(); break;
            case 'import-back': 
              document.getElementById('importStep1')?.classList.remove('hidden'); 
              document.getElementById('importStep2')?.classList.add('hidden'); 
              break;
            case 'csv': UI.exportCSV(); break;
            case 'pdf': UI.exportPDF(); break;
            case 'copy': UI.copy(); break;
            case 'share': UI.initShare(State.analysisId); break;
            case 'del-form': await UI.delForm(id); break; // ✅ Await deletion
            case 'del-user': 
              if(confirm('Delete user?')){
                const s = await API.delUser(id);
                if(s.error) toast(s.error, 'error');
                else { toast('Deleted', 'success'); UI.admin(); }
              }
              break;
            default: console.warn('Unknown action:', a);
          }
        } catch(err){ 
          console.error('Action failed:', a, err);
          toast('Action failed: ' + err.message, 'error'); 
        }
        return;
      } 
      if(!e.target.closest('.user-menu') && !e.target.closest('#userMenuBtn')) {
        document.getElementById('userDropdown')?.classList.remove('open'); 
      }
    });

    document.getElementById('userMenuBtn')?.addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('userDropdown')?.classList.toggle('open');
    });
    
    // Auth Forms
    document.getElementById('formLogin')?.addEventListener('submit', async e => {
      e.preventDefault();
      const b = e.target.querySelector('button'),
            em = document.getElementById('loginEmail'),
            pw = document.getElementById('loginPass'),
            er = document.getElementById('loginError');
      
      if(er) er.classList.add('hidden');
      if(!em.value.includes('@')){
        if(er){ er.textContent = 'Valid email required'; er.classList.remove('hidden'); }
        return;
      }
      if(!pw.value){
        if(er){ er.textContent = 'Password required'; er.classList.remove('hidden'); }
        return;
      }
      try{
        b.disabled = true; b.textContent = 'Signing in...';
        const r = await API.login({email: em.value, password: pw.value});
        if(r.error) throw new Error(r.error);
        State.user = r.user;
        UI.authUI();
        nav('home');
      }catch(ex){
        if(er){ er.textContent = ex.message; er.classList.remove('hidden'); }
        b.disabled = false; b.textContent = 'Sign In';
      }
    });
    
    document.getElementById('formSignup')?.addEventListener('submit', async e => {
      e.preventDefault();
      const b = e.target.querySelector('button'),
            nm = document.getElementById('signupName'),
            em = document.getElementById('signupEmail'),
            pw = document.getElementById('signupPass'),
            er = document.getElementById('signupError');
      
      if(er) er.classList.add('hidden');
      if(!nm.value.trim()){
        if(er){ er.textContent = 'Name required'; er.classList.remove('hidden'); }
        return;
      }
      if(!em.value.includes('@')){
        if(er){ er.textContent = 'Valid email required'; er.classList.remove('hidden'); }
        return;
      }
      if(pw.value.length < 8 || !/[A-Z]/.test(pw.value) || !/\d/.test(pw.value)){
        if(er){ er.textContent = '8+ chars, 1 uppercase, 1 number'; er.classList.remove('hidden'); }
        return;
      }
      try{
        b.disabled = true; b.textContent = 'Creating...';
        const r = await API.signup({name: nm.value, email: em.value, password: pw.value});
        if(r.error) throw new Error(r.error);
        State.user = r.user;
        UI.authUI();
        nav('home');
      }catch(ex){
        if(er){ er.textContent = ex.message; er.classList.remove('hidden'); }
        b.disabled = false; b.textContent = 'Create Account';
      }
    });
    
    // Date Filter for Analysis
    document.getElementById('dateFilter')?.addEventListener('change', () => {
      if(State.analysisId) UI.initAnalysis(State.analysisId);
    });
    
    // Search & Filters
    document.getElementById('globalSearch')?.addEventListener('input', () => {
      const a = document.querySelector('.f-btn.active');
      UI.myForms(a ? a.dataset.filter : 'all');
    });
    document.querySelectorAll('.f-btn').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.f-btn').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      UI.myForms(t.dataset.filter);
    }));
    
    // Form Submissions
    document.getElementById('takeForm')?.addEventListener('submit', e => { e.preventDefault(); });
    const p = new URLSearchParams(location.search); 
    if(p.get('take')) setTimeout(() => nav('take', {id: p.get('take')}), 100);
    
    // Password Toggles
    document.querySelectorAll('.toggle-pass').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = document.getElementById(btn.dataset.target);
        if(inp){
          inp.type = inp.type === 'password' ? 'text' : 'password';
          btn.innerHTML = inp.type === 'password'
            ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
            : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
        }
      });
    });
    
    // Password Strength
    document.getElementById('signupPass')?.addEventListener('input', e => { 
      const v = e.target.value, m = document.getElementById('passMeter');
      if(!m) return;
      m.className = 'meter';
      if(!v) return;
      m.classList.add(
        v.length < 8 || !/[A-Z]/.test(v) || !/\d/.test(v) ? 'weak' : 
        v.length < 10 ? 'medium' : 'strong'
      ); 
    });
    
    // AI Generator
    const aGM = document.getElementById('aiGenModal'); 
    document.getElementById('aiGenBtn')?.addEventListener('click', () => aGM?.classList.add('active')); 
    document.querySelectorAll('[data-action="close-ai-gen"]').forEach(b => b.addEventListener('click', () => aGM?.classList.remove('active')));
    
    document.getElementById('aiGenForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const b = document.getElementById('aiGenSubmit'), st = document.getElementById('aiGenStatus');
      b.disabled = true; b.innerHTML = '<span class="spinner"></span><span>Generating...</span>';
      st.classList.remove('hidden'); st.className = 'msg'; st.textContent = 'Crafting...';
      try{
        const r = await fetch('/api/ai/generate', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            topic: document.getElementById('aiTopic').value,
            count: document.getElementById('aiCount').value,
            context: document.getElementById('aiContext').value
          })
        });
        const d = await r.json();
        if(d.error) throw new Error(d.error);
        if(d.questions.length > 0){
          UI.addSection({title: 'AI Generated'});
          d.questions.forEach(q => UI.addQuestion(
            document.querySelector('.form-section:last-child').dataset.secId, 
            q
          ));
        }
        st.className = 'msg';
        st.textContent = `✅ Added ${d.questions.length}!`;
        st.style.color = 'var(--success)';
        setTimeout(() => aGM.classList.remove('active'), 1200);
      }catch(err){
        st.className = 'msg error';
        st.textContent = '❌ ' + err.message;
        b.disabled = false;
        b.innerHTML = '<span class="btn-text">Generate</span>';
      }
    });
  });
})();