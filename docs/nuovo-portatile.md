# Passare lo studio su un nuovo portatile

Checklist per spostare tutto quello che gira sul Mac (The Motion del mattino, The Trap del martedì, la coda notturna degli studi, le card Ko-fi) da un portatile all'altro. Il codice è tutto su GitHub; quello che vive solo sul Mac è `~/.agent-dispatch` (risultati e impostazioni), i job pianificati, le chiavi nel Portachiavi, i login dei tre agenti e i modelli Ollama.

## 1. Sul vecchio portatile, prima di spegnerlo

1. Aspetta che non stia girando niente: né la coda notturna (finisce alle 07:15) né The Motion (08:00 nei giorni feriali).
2. Ferma i job pianificati, così non girano due volte quando il nuovo è pronto (non cancella nulla):

   ```sh
   launchctl unload ~/Library/LaunchAgents/com.agents-wrapper.motion-daily.plist
   launchctl unload ~/Library/LaunchAgents/com.agents-wrapper.trap-weekly.plist 2>/dev/null
   ```

3. Fai il backup di quello che non è su GitHub:

   ```sh
   cd ~/agents-wrapper && git pull --ff-only && sh scripts/backup-laptop.sh
   ```

   Crea `~/studio-backup-AAAA-MM-GG.tgz` (circa 200 MB) con tutto `~/.agent-dispatch` (risultati di studi, bench, rooms, organise, ideate, stato della coda notturna, impostazioni degli show, checkout `trap-site`), `~/kofi`, i log dei libri in `~/agents-wrapper/*.log` e una cartella `laptop-info` con i job launchd, i modelli Ollama, gli strumenti installati e i commit non ancora su GitHub (devono essere zero). Nessun segreto: Portachiavi, login e modelli restano fuori.
4. Copia il `.tgz` sul nuovo portatile (AirDrop o disco esterno) e tienine una seconda copia fuori dal portatile.
5. Fuori da questo progetto: `~/claude-projects` (circa 670 MB, di cui 579 MB in `jira-horror`) non è sotto git. Se ti serve, copialo a mano.

## 2. Sul nuovo portatile

1. Strumenti: Node (anche in `~/.local/node`), git, `gh`, Claude Code (`claude`), Antigravity CLI (`agy`), Codex CLI (`codex`), Ollama. Metti nel `~/.zprofile`:

   ```sh
   export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
   ```

2. Login, a mano, uno per uno: `claude` (poi `/login`), `agy`, `codex login`, `gh auth login`.
3. Chiavi nel Portachiavi (le chiede senza mostrarle; non incollarle mai in chat):

   ```sh
   security add-generic-password -a "$USER" -s second-room-gemini -w
   security add-generic-password -a "$USER" -s openrouter-key -w
   ```

4. Codice e backup:

   ```sh
   git clone https://github.com/carlobeschi/agents-wrapper.git ~/agents-wrapper
   git clone https://github.com/carlobeschi/model-behaviour.git ~/the-motion
   tar -xzf ~/studio-backup-*.tgz -C ~
   ```

5. Controllo e preparazione: `sh ~/agents-wrapper/scripts/setup-mac.sh`. Dice cosa manca (TODO) e prepara il resto senza sovrascrivere nulla. Poi:
   - `sh scripts/setup-mac.sh --models` scarica `qwen3:8b` e `gemma3:12b` (circa 13 GB; senza `gemma3:12b` lo studio 10 salta le sue ripetizioni);
   - `sh scripts/setup-mac.sh --schedule` installa The Motion (feriali 08:00) e The Trap (martedì 18:00), solo dopo il passo 1.2 sul vecchio;
   - `sudo pmset repeat wakeorpoweron MTWRF 07:55:00` sveglia il Mac per The Motion.
6. Prova: `node motion-daily.js --dry-run` (si ferma prima del merge) e `node night.js --list` (deve mostrare i job già fatti).
7. Claude desktop: accedi, collega il nuovo computer a questo progetto e approva di nuovo le cartelle `~/agents-wrapper` e `~/.agent-dispatch/studies`. Per i post Ko-fi serve Claude in Chrome con l'accesso a Ko-fi.

## Cosa si ferma durante il passaggio

- **The Motion** (feriali 08:00): salta i giorni in cui nessun portatile la esegue. La scelta della mozione dalle newsletter gira nel cloud e continua a scrivere sul ramo `queue`; un giorno saltato non pubblica niente.
- **The Trap** (martedì 18:00, episodio il mercoledì): salta se il passaggio cade di martedì.
- **Coda notturna** (studio 10 e il resto): riparte dove era rimasta solo se `~/.agent-dispatch/night/state.json` e le cartelle dei risultati arrivano dal backup.
- **Post Ko-fi** e lavoro dei thread sul Mac (Remote Control, cartelle approvate): fermi finché il nuovo computer non è collegato.
