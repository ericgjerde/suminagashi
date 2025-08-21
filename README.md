# Suminagashi 3D

An interactive WebGL2 simulation of **Suminagashi** (墨流し) - the ancient Japanese art of paper marbling, rendered in real-time 3D. This implementation uses fluid dynamics to create mesmerizing ink patterns that float and swirl on a virtual water surface.

## 🎨 What is Suminagashi?

Suminagashi, meaning "floating ink" in Japanese, is one of the oldest forms of decorative paper art, dating back to the 12th century. Artists carefully drop ink onto water, manipulate it with tools, and transfer the resulting patterns to paper. This digital interpretation brings this traditional art form to the browser with physics-based fluid simulation.

## ✨ Features

- **Real-time Fluid Simulation**: GPU-accelerated Navier-Stokes fluid dynamics
- **Interactive Tools**:
  - **Ink Dropper**: Click to drop colored ink that spreads naturally on the water surface
  - **Stylus**: Drag to create currents and swirls in the water
  - **Comb**: Multi-pronged tool for creating parallel flowing patterns
- **3D Visualization**: View the water surface from different angles with adjustable camera controls
- **Customizable Physics**:
  - Adjustable viscosity for different fluid behaviors
  - Pressure solver iterations for accuracy
  - Ink dissipation control
- **WebGL2 Compatibility Mode**: Includes fallback paths for broader device support

## 🚀 Live Demo

Try it directly in your browser - no installation needed! The simulation runs entirely on your GPU using WebGL2.

### System Requirements
- Modern web browser with WebGL2 support (Chrome, Firefox, Edge, Safari 15+)
- GPU with reasonable performance (integrated graphics work, dedicated GPUs provide better performance)

## 🎮 Controls

### Mouse/Touch Controls
- **Click**: Drop ink at cursor position
- **Drag**: Apply force to the fluid (with Stylus or Comb tool selected)
- **Shift + Drag**: Apply force while also laying down ink

### Keyboard Shortcuts
- **R**: Reset the simulation
- **D**: Toggle debug mode (shows dye texture directly)
- **S**: Toggle simple rendering mode

### UI Controls
- **Tool Selection**: Switch between Ink Dropper, Stylus, and Comb
- **Ink Color**: Choose the color of dropped ink
- **Ink Radius**: Control the size of ink drops
- **Force/Radius**: Adjust the strength and size of fluid disturbance
- **Viscosity**: Change how "thick" the fluid feels
- **Camera Controls**: Adjust viewing angle (tilt and spin)

## 🔧 Technical Details

### Architecture
The simulation consists of several components:

1. **Fluid Solver** (`app.js`)
   - Semi-Lagrangian advection for stability
   - Jacobi iteration for pressure projection
   - Vorticity confinement for detail preservation
   - Encoded velocity fields for compatibility mode

2. **Rendering Pipeline**
   - Grid-based 3D water surface with dynamic height mapping
   - Physically-based shading with Fresnel reflections
   - Environmental reflections and specular highlights
   - Screen-space effects and vignetting

3. **Shader Programs**
   - Advection shader for fluid transport
   - Divergence calculation
   - Pressure solver (Poisson equation)
   - Gradient subtraction for incompressibility
   - Splat shaders for user interaction
   - 3D surface rendering with normal mapping

### Browser Compatibility
The application includes multiple rendering paths:
- **Float texture path**: For GPUs supporting `EXT_color_buffer_float`
- **Compatibility path**: Encoded velocity in 8-bit textures for older GPUs
- **2D fallback**: Top-down view when 3D rendering has issues

## 📁 Project Structure

```
suminagashi/
├── index.html          # Main application page
├── app.js             # Core simulation and rendering logic
├── style.css          # UI styling
├── debug.html         # Debug visualization page
├── test.html          # Test pages for development
├── test-render.html   # Rendering tests
├── test-simple.html   # Simple rendering tests
├── standalone-test.html # Standalone test environment
└── validate.js        # WebGL validation utilities
```

## 🛠️ Development

### Local Development
1. Clone the repository:
```bash
git clone git@github.com:ericgjerde/suminagashi.git
cd suminagashi
```

2. Serve the files locally (requires a web server for WebGL):
```bash
# Using Python
python3 -m http.server 8080

# Using Node.js
npx http-server -p 8080

# Using any other static file server
```

3. Open in browser: `http://localhost:8080`

### Debugging
- Open browser console for GPU info and performance metrics
- Use the debug pages (`debug.html`, `test-*.html`) for isolated feature testing
- Toggle debug mode with 'D' key to visualize internal textures

## 🎨 Customization

### Adding New Tools
Tools are defined in the `disturb()` function in `app.js`. You can create new interaction patterns by modifying the force application logic.

### Modifying Physics
Adjust these constants in `app.js`:
- `VEL_SCALE`: Velocity encoding scale
- Viscosity range in UI
- Pressure iteration count
- Time step (`dt`) in the simulation loop

### Visual Tweaks
The rendering can be customized by modifying:
- Water color tints in the fragment shader
- Environmental lighting in `sky()` function
- Fresnel parameters for reflectivity
- Height scale for 3D surface displacement

## 📝 Technical Notes

### WebGL2 Features Used
- Vertex Array Objects (VAOs)
- Multiple Render Targets (MRTs)
- Floating-point textures (when available)
- GLSL ES 3.0 shaders

### Performance Optimizations
- Ping-pong framebuffers for in-place computation
- Texture resolution scaling based on viewport
- Efficient grid mesh generation
- Cached shader compilations

### Known Limitations
- Safari requires WebGL2 to be enabled in Experimental Features
- Some mobile GPUs may have reduced performance
- Very high-resolution displays may need DPR adjustment

## 🙏 Acknowledgments

This project draws inspiration from:
- Traditional Japanese Suminagashi artists
- Fluid dynamics research in computer graphics
- The WebGL community for shader techniques

## 📄 License

This project is open source and available for educational and artistic purposes.

## 🤝 Contributing

Contributions are welcome! Feel free to:
- Report bugs or compatibility issues
- Suggest new features or tools
- Optimize performance
- Improve documentation

## 📧 Contact

Created by Eric Gjerde

---

*Experience the meditative art of digital Suminagashi - where code meets tradition, and mathematics creates beauty.*