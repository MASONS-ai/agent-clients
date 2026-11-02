import type { Register } from 'claude-code'

// The plugin's one hooks module: Claude Code refuses a second module, and a
// second `session.start` hook in this one. Both watches start from that hook,
// each in a function declared here, because Claude Code 2.1.287 does not follow
// `$` across an import.
export const register: Register = on => {
  let watching: { cancel: () => void } | undefined
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const companion = `${$.plugin.root}/scripts/companion.mjs`

    // A message arriving at an idle window. The arrival receiver decides when
    // a turn starts and hands it to this window's mod through a file; the
    // companion claims it and prints the notice, and the mod starts the turn
    // with exactly that text as the plugin's message. An arrival no mod
    // claims is the receiver's own.
    const watchArrivals = async () => {
      const init = await $.process.run(['node', companion, 'arrival-init'])
      if (init.exitCode !== 0) return
      const request = init.stdout
      await $.env.set('MASONS_ARRIVAL_MOD', '1')
      $.clock.every(500, async () => {
        try {
          if (!(await $.fs.exists(request))) return
          const claim = await $.process.run(['node', companion, 'arrival-claim'])
          if (claim.exitCode !== 0 || claim.stdout === '') return
          void $.prompt.submit({ text: claim.stdout }).then(
            submitted => submitted.drop !== undefined && $.ui.log(`arrival not submitted: ${submitted.drop}`, { to: 'debug' }),
            error => $.ui.log(`arrival not submitted: ${String(error)}`, { to: 'debug' }),
          )
        } catch (error) {
          $.ui.log(`arrival failed: ${String(error)}`, { to: 'debug' })
        }
      })
    }

    // A plugin update reaching a terminal window already open: when Claude
    // Code's install record changes and the companion names a newer build for
    // this window, run /reload-plugins here, as if the person had typed it.
    // Only the terminal: Claude Desktop's /reload-plugins does not restart
    // this plugin's MCP server, and a headless or automated run is nobody's
    // window.
    const watchUpdates = async () => {
      if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'cli') return
      const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
      const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
      const record = `${config}/plugins/installed_plugins.json`
      let seen: string | undefined
      watching?.cancel()
      watching = $.clock.every(5000, async () => {
        try {
          const text = (await $.fs.exists(record)) ? await $.fs.read(record) : ''
          if (seen === undefined || text === seen) {
            seen = text
            return
          }
          seen = text
          const check = await $.process.run(['node', companion, 'update-check'])
          if (check.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(check.stdout)) return
          await $.command.run({ command: 'reload-plugins' })
        } catch (error) {
          $.ui.log(`plugin update not applied: ${String(error)}`, { to: 'debug' })
        }
      })
    }

    for (const [name, watch] of [['arrival', watchArrivals], ['plugin update', watchUpdates]] as const) {
      try {
        await watch()
      } catch (error) {
        $.ui.log(`${name} watch not started: ${String(error)}`, { to: 'debug' })
      }
    }
    return started
  })
}
