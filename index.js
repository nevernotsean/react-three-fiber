/** TODOS
 * 1. Intersection has be more specific, it goes through the entire scene currently
 * 2. Fix camera
 * 3. Better way to set up the scene declaratively
 * 4. make it possible to render into a target without regressions
 */

import * as THREE from 'three'
import React, { useRef, useEffect, useState, useCallback, useContext } from 'react'
import Reconciler from 'react-reconciler'
import omit from 'lodash-es/omit'
import upperFirst from 'lodash-es/upperFirst'
import ResizeObserver from 'resize-observer-polyfill'
import {
  unstable_scheduleCallback as scheduleDeferredCallback,
  unstable_cancelCallback as cancelDeferredCallback,
  unstable_now as now,
} from 'scheduler'

const roots = new Map()
const emptyObject = {}

export function applyProps(instance, newProps, oldProps = {}) {
  // Filter equals, events and reserved props
  const sameProps = Object.keys(newProps).filter(key => newProps[key] === oldProps[key])
  const handlers = Object.keys(newProps).filter(key => typeof newProps[key] === 'function' && key.startsWith('on'))
  const filteredProps = omit(newProps, [...sameProps, ...handlers, 'children', 'key', 'ref'])
  if (Object.keys(filteredProps).length > 0) {
    Object.entries(filteredProps).forEach(([key, value]) => {
      let root = instance
      let target = root[key]
      if (key.includes('-')) {
        const entries = key.split('-')
        target = entries.reduce((acc, key) => acc[key], instance)
        if (target && !target.set) {
          // The target is atomic, this forces us to switch the root
          const [name, ...reverseEntries] = entries.reverse()
          root = reverseEntries.reverse().reduce((acc, key) => acc[key], instance)
          key = name
        }
      }
      if (target && target.set) {
        if (target.constructor.name === value.constructor.name) {
          target.copy(value)
        } else if (Array.isArray(value)) {
          target.set(...value)
        } else {
          target.set(value)
        }
      } else root[key] = value
    })

    if (handlers.length) {
      instance.__handlers = handlers.reduce((acc, key) => {
        const name = key.charAt(2).toLowerCase() + key.substr(3)
        return { ...acc, [name]: newProps[key] }
      }, {})
      // Call the update lifecycle, if present
      if (instance.__handlers.update) instance.__handlers.update(instance)
    }
  }
}

function createInstance(type, { args = [], ...props }) {
  let name = upperFirst(type)
  let instance = type === 'primitive' ? props.object : new THREE[name](...args)
  applyProps(instance, props, {})
  if (!instance.isObject3D) instance = { current: instance }
  return instance
}

function appendChild(parentInstance, child) {
  if (child) {
    if (child.isObject3D) parentInstance.add(child)
    else if (child.current.name) {
      child.parent = parentInstance
      applyProps(parentInstance.isObject3D ? parentInstance : parentInstance.current, {
        [child.current.name]: child.current,
      })
    }
  }
}

function removeChild(parentInstance, child) {
  if (child) {
    if (child.isObject3D) parentInstance.remove(child)
    else child.parent = undefined
  }
}

const Renderer = Reconciler({
  now,
  createInstance,
  removeChild,
  appendChild,
  supportsMutation: true,
  isPrimaryRenderer: false,
  schedulePassiveEffects: scheduleDeferredCallback,
  cancelPassiveEffects: cancelDeferredCallback,
  appendInitialChild: appendChild,
  appendChildToContainer: appendChild,
  removeChildFromContainer: removeChild,
  insertBefore(parentInstance, child, beforeChild) {
    if (child) {
      if (child.isObject3D) {
        child.parent = parentInstance
        child.dispatchEvent({ type: 'added' })
        // TODO: the order is out of whack if data objects are present, has to be recalculated
        const index = parentInstance.children.indexOf(beforeChild)
        parentInstance.children = [
          ...parentInstance.children.slice(0, index),
          child,
          ...parentInstance.children.slice(index),
        ]
      } else child.parent = parentInstance
    }
  },
  commitUpdate(instance, updatePayload, type, oldProps, newProps, fiber) {
    if (instance.isObject3D) {
      applyProps(instance, newProps, oldProps)
    } else {
      // This is a data object, let's extract critical information about it
      const parent = instance.parent
      const { args: argsNew = [], ...restNew } = newProps
      const { args: argsOld = [], ...restOld } = oldProps
      // If it has new props or arguments, then it needs to be re-instanciated
      if (argsNew.some((value, index) => value !== argsOld[index])) {
        // Next we create a new instance and append it again
        const newInstance = createInstance(instance.current.type, newProps)
        removeChild(parent, instance)
        appendChild(parent, newInstance)
        // Switch instance
        instance.current = newInstance.current
        instance.parent = newInstance.parent
      } else {
        // Otherwise just overwrite props
        applyProps(instance.current, restNew, restOld)
      }
    }
  },
  getPublicInstance(instance) {
    return instance
  },
  getRootHostContext(rootContainerInstance) {
    return emptyObject
  },
  getChildHostContext(parentHostContext, type) {
    return emptyObject
  },
  createTextInstance() {},
  finalizeInitialChildren(instance, type, props, rootContainerInstance) {
    return false
  },
  prepareUpdate(instance, type, oldProps, newProps, rootContainerInstance, hostContext) {
    return emptyObject
  },
  shouldDeprioritizeSubtree(type, props) {
    return false
  },
  prepareForCommit() {},
  resetAfterCommit() {},
  shouldSetTextContent(props) {
    return false
  },
})

export function render(element, container) {
  let root = roots.get(container)
  if (!root) {
    root = Renderer.createContainer(container)
    roots.set(container, root)
  }
  Renderer.updateContainer(element, root, null, undefined)
  return Renderer.getPublicRootInstance(root)
}

export function unmountComponentAtNode(container) {
  const root = roots.get(container)
  if (root) Renderer.updateContainer(null, root, null, () => roots.delete(container))
}

function useMeasure() {
  const ref = useRef()
  const [bounds, set] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [ro] = useState(() => new ResizeObserver(([entry]) => set(entry.contentRect)))
  useEffect(() => {
    if (ref.current) ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [{ ref }, bounds]
}

export const context = React.createContext()

export const Canvas = React.memo(({ children, style, camera, render: renderFn, onCreated, onUpdate, ...props }) => {
  const canvas = useRef()
  const state = useRef({
    subscribers: [],
    active: true,
    canvas: undefined,
    gl: undefined,
    camera: undefined,
    scene: undefined,
    size: undefined,
    subscribe: fn => {
      state.current.subscribers.push(fn)
      return () => (state.current.subscribers = state.current.subscribers.filter(s => s === fn))
    },
  })

  const [bind, size] = useMeasure()
  state.current.size = size

  const [raycaster] = useState(() => new THREE.Raycaster())
  const [mouse] = useState(() => new THREE.Vector2())
  const [cursor, setCursor] = useState('default')

  useEffect(() => {
    state.current.scene = window.scene = new THREE.Scene()
    state.current.gl = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true })
    state.current.gl.setClearAlpha(0)

    state.current.camera = (camera && camera.current) || new THREE.PerspectiveCamera(75, 0, 0.1, 1000)
    state.current.gl.setSize(0, 0, false)
    state.current.camera.position.z = 5
    state.current.canvas = canvas.current

    if (onCreated) onCreated(state.current)

    const renderLoop = () => {
      if (!state.current.active) return
      requestAnimationFrame(renderLoop)
      if (onUpdate) onUpdate(state.current)
      state.current.subscribers.forEach(fn => fn(state.current))
      if (renderFn) renderFn(state.current)
      else state.current.gl.render(state.current.scene, state.current.camera)
    }

    // Start render-loop
    requestAnimationFrame(renderLoop)

    // Clean-up
    return () => {
      state.current.active = false
      unmountComponentAtNode(state.current.scene)
    }
  }, [])

  useEffect(() => {
    state.current.gl.setSize(state.current.size.width, state.current.size.height, false)
    const aspect = state.current.size.width / state.current.size.height
    state.current.camera.aspect = aspect
    state.current.camera.updateProjectionMatrix()
    state.current.camera.radius = (state.current.size.width + state.current.size.height) / 4
  })

  const intersect = useCallback(({clientX, clientY}, fn) => {
    mouse.x = (clientX / state.current.size.width) * 2 - 1
    mouse.y = (clientY / state.current.size.height) * 2 + 1
    raycaster.setFromCamera(mouse, state.current.camera)
    const intersects = raycaster.intersectObjects(state.current.scene.children, true)
    for (let i = 0; i < intersects.length; i++) {
      if (!intersects[i].object.__handlers) continue
      fn(intersects[i])
    }
    return intersects
  })

  useEffect(() => {
    const hovered = {}
    const handleMove = event => {
      let hover = false
      let intersects = intersect(event, data => {
        const object = data.object
        const handlers = object.__handlers
        if (handlers.hover) {
          hover = true
          if (!hovered[object.uuid]) {
            hovered[object.uuid] = object
            handlers.hover(data)
          }
        }
      })

      if (hover) cursor !== 'pointer' && setCursor('pointer')
      else cursor !== 'default' && setCursor('default')

      Object.values(hovered).forEach(object => {
        if (!intersects.length || !intersects.find(i => i.object === object)) {
          if (object.__handlers.unhover) object.__handlers.unhover()
          delete hovered[object.uuid]
        }
      })
    }
    window.addEventListener('mousemove', handleMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', handleMove)
    }
  })

  // Render v-dom into scene
  useEffect(() => {
    if (state.current.size.width > 0) {
      render(<context.Provider value={{ ...state.current }} children={children} />, state.current.scene)
    }
  })

  // Render the canvas into the dom
  return (
    <div
      {...bind}
      {...props}
      onClick={event => {
        const clicked = {}
        intersect(event, data => {
          const object = data.object
          const handlers = object.__handlers
          if (handlers.click && !clicked[object.uuid]) {
            clicked[object.uuid] = object
            handlers.click(data)
          }
        })
      }}
      style={{ cursor, position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <canvas ref={canvas} />
    </div>
  )
})

export function useRender(fn) {
  const { subscribe } = useContext(context)
  useEffect(() => subscribe(fn), [])
}

export function useThree(fn) {
  const { subscribe, ...props } = useContext(context)
  return props
}
