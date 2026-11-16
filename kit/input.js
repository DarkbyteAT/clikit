/**
 * Kit input: one pointer abstraction for touch, mouse and keyboard.
 *
 * Owns:  turning raw pointer and key events on the stage canvas into three game-level events
 *        (tap, swipe - once per gesture, drag - start / move / end), the live pointer state, the
 *        virtual joystick (`stick`) and its on-screen ring, and pointer-to-world picking.
 * Does not own: HUD buttons (ui.js handles its own clicks), game rules, or the listeners' lifetime
 *        beyond `dispose()` (the shell calls that on exit / restart).
 *
 * Needs the DOM and THREE, so it is exercised by tools/smoke.js rather than unit tests; the
 * gesture maths is kept in the small pure functions at the top.
 */
(() => {
  // ---- tunables (CSS pixels and milliseconds) ------------------------------------------------------------------------

  /** A drag longer than this counts as a swipe. */
  const SWIPE_DISTANCE_PX = 26;
  /** A press only counts as a tap if the finger strayed less than this ... */
  const TAP_MAX_TRAVEL_PX = 12;
  /** ... and was lifted within this time. */
  const TAP_MAX_DURATION_MS = 280;
  /** Drag distance at which the virtual joystick reaches full deflection; also the on-screen ring's radius. */
  const STICK_RADIUS_PX = 56;

  /** Keyboard keys that act as the four directions (arrows and WASD). */
  const DIRECTION_BY_KEY = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down' };
  /** Keyboard keys that act as a tap in the middle of the screen. */
  const TAP_KEYS = [' ', 'Enter'];

  // ---- pure gesture maths --------------------------------------------------------------------------------------------

  /**
   * The direction of a swipe from its offset: whichever axis moved further decides.
   * @param {number} offsetX pixels right of the touch-down point
   * @param {number} offsetY pixels below the touch-down point
   * @returns {'left'|'right'|'up'|'down'}
   */
  const swipeDirection = (offsetX, offsetY) => {
    if (Math.abs(offsetX) > Math.abs(offsetY)) return offsetX > 0 ? 'right' : 'left';
    return offsetY > 0 ? 'down' : 'up';
  };

  /**
   * Joystick deflection for a drag offset: proportional up to the stick radius, then held at full
   * deflection in the same direction.
   * @param {number} offsetX pixels
   * @param {number} offsetY pixels
   * @returns {{x: number, y: number}} each -1..1, length at most 1
   */
  const stickFromOffset = (offsetX, offsetY) => {
    const distance = Math.hypot(offsetX, offsetY);
    const shrink = distance > STICK_RADIUS_PX ? STICK_RADIUS_PX / distance : 1;
    return { x: (offsetX * shrink) / STICK_RADIUS_PX, y: (offsetY * shrink) / STICK_RADIUS_PX };
  };

  /**
   * Joystick deflection for the direction keys held down. Diagonals are normalised so they are
   * no faster than a straight line.
   * @param {Set<string>} heldKeys `event.key` values
   * @returns {{x: number, y: number}}
   */
  const stickFromKeys = (heldKeys) => {
    const isHeld = (direction) => [...heldKeys].some((key) => DIRECTION_BY_KEY[key] === direction);
    const x = Number(isHeld('right')) - Number(isHeld('left'));
    const y = Number(isHeld('down')) - Number(isHeld('up'));
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  };

  /**
   * @typedef {Object} PointerState
   * Live state of the primary pointer (field names are short because games read them every frame).
   * @property {boolean} down is a finger / button down?
   * @property {number} x current position, CSS pixels from the left
   * @property {number} y current position, CSS pixels from the top
   * @property {number} nx x in normalised device coordinates, -1 (left) .. 1 (right)
   * @property {number} ny y in normalised device coordinates, -1 (bottom) .. 1 (top)
   * @property {number} sx where the current gesture started, pixels
   * @property {number} sy where the current gesture started, pixels
   * @property {number} t0 when the current gesture started, `performance.now()` milliseconds
   * @property {?number} id pointerId of the gesture (other fingers are ignored until it ends)
   * @property {boolean} swiped has this gesture already fired its swipe?
   * @property {number} moved farthest the gesture has strayed from its start, pixels
   * @property {number} time when the browser saw the pointer at this position, `performance.now()` milliseconds (the event's own time)
   */

  /**
   * @typedef {Object} PointerEventInfo
   * Payload of tap and drag events.
   * @property {'start'|'move'|'end'|'tap'} phase
   * @property {number} x position, pixels
   * @property {number} y position, pixels
   * @property {number} nx normalised device x, -1..1
   * @property {number} ny normalised device y, -1..1 (up is positive)
   * @property {number} dx movement since the previous event, pixels
   * @property {number} dy movement since the previous event, pixels
   * @property {number} tx total offset from the gesture's start, pixels
   * @property {number} ty total offset from the gesture's start, pixels
   * @property {number} time when the browser saw the finger there, milliseconds on the `performance.now()` clock: the
   *   event's own time, not the handler's, so speed and flicks are measured rightly on a frame that ran late
   */

  /**
   * Creates the input layer for a game. The shell does this and exposes it as `ctx.input`.
   * @param {Object} ctx the shell context (uses renderer, size, camera, paused)
   * @returns {{pointer: PointerState, stick: {x: number, y: number, active: boolean},
   *   onTap: function(function(PointerEventInfo): void): function(): boolean,
   *   onSwipe: function(function('left'|'right'|'up'|'down'): void): function(): boolean,
   *   onDrag: function(function(PointerEventInfo): void): function(): boolean,
   *   useStick: function(boolean=): void, ground: function(number=, number=, number=): ?THREE.Vector3,
   *   hit: function(THREE.Object3D[], number=, number=): (Object|undefined), dispose: function(): void}}
   *   `stick.x / .y` are -1..1 in screen space (+x right, +y DOWN the screen), driven by a drag from the
   *   touch-down point or by WASD / arrows. Each `on*` returns an unsubscribe function.
   * @example
   * input.onTap(({ nx, ny }) => fireAt(input.ground(0, nx, ny)));
   * input.onSwipe((direction) => player.dodge(direction));
   * input.useStick(); // show the joystick ring, then read input.stick.x / .y in update()
   */
  Kit.input = (ctx) => {
    const canvas = ctx.renderer.domElement;
    const bus = Kit.bus();
    /** @type {PointerState} */
    const pointer = { down: false, x: 0, y: 0, nx: 0, ny: 0, sx: 0, sy: 0, t0: 0, id: null, swiped: false, moved: 0, time: 0 };
    const stick = { x: 0, y: 0, active: false };
    const heldKeys = new Set();
    const stickElement = document.getElementById('stick');
    let isStickShown = false;

    // ---- pointer bookkeeping ----

    /** Records where the pointer is, in pixels and in normalised device coordinates (y flipped: up is positive). */
    /** The event's own time; a synthetic event without one takes the clock's. */
    const timeOf = (event) => (event.timeStamp > 0 ? event.timeStamp : performance.now());
    const trackPosition = (event) => {
      pointer.time = timeOf(event);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.nx = (pointer.x / ctx.size.w) * 2 - 1;
      pointer.ny = -((pointer.y / ctx.size.h) * 2 - 1);
    };

    /** @returns {PointerEventInfo} a snapshot of the pointer for an event payload */
    const describePointer = (phase, deltaX = 0, deltaY = 0) => ({
      phase,
      time: pointer.time,
      x: pointer.x,
      y: pointer.y,
      nx: pointer.nx,
      ny: pointer.ny,
      dx: deltaX,
      dy: deltaY,
      tx: pointer.x - pointer.sx,
      ty: pointer.y - pointer.sy,
    });

    const setStick = (deflection, isActive) => {
      stick.x = deflection.x;
      stick.y = deflection.y;
      stick.active = isActive;
    };

    /** Shows the joystick ring at the touch-down point with its knob at the current deflection, or hides it. */
    const drawStick = () => {
      if (!stickElement) return;
      stickElement.hidden = !(isStickShown && pointer.down);
      if (stickElement.hidden) return;
      stickElement.style.transform = `translate(${pointer.sx}px, ${pointer.sy}px)`;
      stickElement.firstElementChild.style.transform = `translate(${stick.x * STICK_RADIUS_PX}px, ${stick.y * STICK_RADIUS_PX}px)`;
    };

    const isTap = () => pointer.moved < TAP_MAX_TRAVEL_PX && performance.now() - pointer.t0 < TAP_MAX_DURATION_MS;

    // ---- pointer events ----

    const onPointerDown = (event) => {
      // One gesture at a time: extra fingers are ignored until the first lifts.
      if (pointer.down) return;
      try {
        // Capture keeps move / up events coming when the finger leaves the canvas.
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        // Capture can be refused (synthetic events, a pointer that is already gone); the gesture still works without it.
      }
      trackPosition(event);
      Object.assign(pointer, { down: true, id: event.pointerId, sx: pointer.x, sy: pointer.y, t0: performance.now(), swiped: false, moved: 0 });
      setStick({ x: 0, y: 0 }, true);
      drawStick();
      bus.emit('drag', describePointer('start'));
    };

    const onPointerMove = (event) => {
      if (!pointer.down) {
        // Hovering (mouse): keep the position fresh so ground() and hit() work without a press.
        trackPosition(event);
        return;
      }
      if (event.pointerId !== pointer.id) return;
      const previousX = pointer.x;
      const previousY = pointer.y;
      trackPosition(event);
      const offsetX = pointer.x - pointer.sx;
      const offsetY = pointer.y - pointer.sy;
      const travel = Math.hypot(offsetX, offsetY);
      // `moved` is the farthest point reached, so a press that wanders off and comes back is not a tap.
      pointer.moved = Math.max(pointer.moved, travel);
      setStick(stickFromOffset(offsetX, offsetY), true);
      drawStick();
      bus.emit('drag', describePointer('move', pointer.x - previousX, pointer.y - previousY));
      if (!pointer.swiped && travel > SWIPE_DISTANCE_PX) {
        pointer.swiped = true;
        bus.emit('swipe', swipeDirection(offsetX, offsetY));
      }
    };

    const onPointerUp = (event) => {
      if (!pointer.down || event.pointerId !== pointer.id) return;
      pointer.time = timeOf(event);
      bus.emit('drag', describePointer('end'));
      pointer.down = false;
      setStick({ x: 0, y: 0 }, false);
      drawStick();
      if (isTap()) bus.emit('tap', describePointer('tap'));
    };

    // ---- keyboard ----

    /** Drives the stick from the held direction keys, unless a finger is driving it. */
    const updateStickFromKeys = () => {
      if (pointer.down) return;
      const deflection = stickFromKeys(heldKeys);
      setStick(deflection, Boolean(deflection.x || deflection.y));
    };

    /** A keyboard tap lands in the middle of the screen. */
    const centreTap = () => ({ phase: 'tap', x: ctx.size.w / 2, y: ctx.size.h / 2, nx: 0, ny: 0, dx: 0, dy: 0, tx: 0, ty: 0 });

    const onKeyDown = (event) => {
      if (event.repeat || ctx.paused) return;
      const direction = DIRECTION_BY_KEY[event.key];
      if (direction) {
        heldKeys.add(event.key);
        updateStickFromKeys();
        // A direction key is also a swipe, so swipe-driven games work from the keyboard.
        bus.emit('swipe', direction);
        return;
      }
      if (TAP_KEYS.includes(event.key)) bus.emit('tap', centreTap());
    };

    const onKeyUp = (event) => {
      heldKeys.delete(event.key);
      updateStickFromKeys();
    };

    /** Every DOM listener this module owns, as [target, event type, handler], so add and remove cannot drift apart. */
    const LISTENERS = [
      [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointermove', onPointerMove],
      [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerUp],
      [window, 'keydown', onKeyDown],
      [window, 'keyup', onKeyUp],
    ];
    LISTENERS.forEach(([target, type, handler]) => target.addEventListener(type, handler));

    // ---- picking: scratch objects reused by every call ----
    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const screenPoint = new THREE.Vector2();

    return {
      pointer,
      stick,
      onTap: (listener) => bus.on('tap', listener),
      onSwipe: (listener) => bus.on('swipe', listener),
      onDrag: (listener) => bus.on('drag', listener),
      /** Shows (or hides) the on-screen joystick ring while dragging. */
      useStick(isShown = true) {
        isStickShown = isShown;
      },
      /**
       * World point where the pointer (or the given normalised coordinates) meets the horizontal
       * plane at `height`, through the current ctx.camera. Null when the view ray misses the plane.
       */
      ground(height = 0, nx = pointer.nx, ny = pointer.ny) {
        // THREE's plane is normal . point + constant = 0, so the plane y = height has constant -height.
        groundPlane.constant = -height;
        raycaster.setFromCamera(screenPoint.set(nx, ny), ctx.camera);
        return raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
      },
      /** Raycasts the pointer against objects (and their children); the nearest THREE intersection, or undefined. */
      hit(objects, nx = pointer.nx, ny = pointer.ny) {
        raycaster.setFromCamera(screenPoint.set(nx, ny), ctx.camera);
        return raycaster.intersectObjects(objects, true)[0];
      },
      dispose() {
        LISTENERS.forEach(([target, type, handler]) => target.removeEventListener(type, handler));
        if (stickElement) stickElement.hidden = true;
        bus.clear();
      },
    };
  };
})();
