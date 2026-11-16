// Reference game: touches every kit API in ~60 lines. Copy the shape, not the content.
Kit.register({
  id: 'arena', name: 'Example', tagline: 'Drag to roll, tap to pop', hook: 'Shows the kit API', color: '#ff5d73', order: 1,
  create(ctx) {
    const { make, input, fx, sfx, ui, save, math, camera, THREE } = ctx;
    const stage = make.stage({ sky: [0x2b3a7a, 0x0b1026], fog: [18, 50] });
    make.ground(80, 0x27304f, { grid: 0x8899ff });
    const ball = make.sphere(0.6, 0xffc145, { at: [0, 0.6, 0], emissive: 0xffc145, emissiveIntensity: 0.2 });
    make.glow(0xffc145, 3, { parent: ball, depthTest: false });
    const gems = ctx.pool(() => make.ico(0.35, 0, 0x4de2c5, { emissive: 0x4de2c5, emissiveIntensity: 0.5 }));
    const spawn = () => gems.get().position.set(math.rand(-7, 7), 0.5, math.rand(-7, 7));
    for (let i = 0; i < 8; i++) spawn();
    let score = 0, level = 1;
    const best = save.get('best', 0);
    const sScore = ui.stat('Score', 0), sBest = ui.stat('Best', best);
    const xp = ui.progress('Level 1');
    const hint = ui.hint('Drag to roll');
    input.useStick();
    input.onTap(() => { fx.ring(ball.position, { color: 0xffc145 }); fx.shake(0.3); sfx.play('thud'); });
    ui.actions([{ id: 'boom', label: 'Boom', sub: 'free', onClick: () => { fx.burst(ball.position, { count: 40, colors: [0xff5d73, 0xffc145] }); fx.flash('#fff'); sfx.play('boom'); } }]);
    camera.position.set(0, 12, 10);
    const vel = new THREE.Vector3();
    return {
      update(dt, t) {
        if (input.stick.active) hint.hide();
        vel.x = math.damp(vel.x, input.stick.x * 8, 10, dt);
        vel.z = math.damp(vel.z, input.stick.y * 8, 10, dt);
        ball.position.addScaledVector(vel, dt);
        gems.each((g) => {
          g.rotation.y += dt * 2;
          if (g.position.distanceTo(ball.position) < 1) {
            fx.burst(g.position, { color: 0x4de2c5, count: 14 }); fx.floater('+1', g.position); fx.hitstop(30); sfx.play('coin');
            gems.release(g); spawn();
            sScore.set(++score); sScore.pulse();
            if (score > save.get('best', 0)) sBest.set(save.set('best', score));
            xp.set((score % 5) / 5);
            if (score % 5 === 0) ui.choose({ title: 'Level up', options: [{ title: 'Bigger', desc: 'Grow the ball', tag: 'size' }, { title: 'Nothing', desc: 'Stay the same' }] })
              .then((i) => { if (i === 0) ctx.tween(ball.scale, { x: ball.scale.x * 1.2, y: ball.scale.y * 1.2, z: ball.scale.z * 1.2 }, 0.4, 'outBack'); xp.label('Level ' + ++level); sfx.play('up'); });
          }
        });
        camera.position.x = math.damp(camera.position.x, ball.position.x, 4, dt);
        camera.position.z = math.damp(camera.position.z, ball.position.z + 10, 4, dt);
        camera.lookAt(ball.position);
        stage.follow(ball.position);
      },
    };
  },
});
