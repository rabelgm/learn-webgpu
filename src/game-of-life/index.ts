const GRID_SIZE = Math.pow(4, 4);
const WORKGROUP_SIZE = 8;
let step = 0; // Track how many simulation steps have been run

export async function main() {
  const app = document.querySelector<HTMLDivElement>("#app");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("width", "800");
  canvas.setAttribute("height", "800");

  const stepDisplay = document.createElement("span");

  app?.appendChild(canvas);
  app?.appendChild(stepDisplay);

  if (!navigator.gpu) {
    throw new Error("WebGPU not supported on this browser.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No appropriate GPUAdapter found.");
  }

  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  if (!context) {
    throw new Error("Canvas context not initialized.");
  }

  context.configure({
    device: device,
    format: canvasFormat,
  });

  const vertices = new Float32Array([
    //   X,    Y,
    -1,
    -1, // Triangle 1 (Blue)
    1,
    -1,
    1,
    1,

    -1,
    -1, // Triangle 2 (Red)
    1,
    1,
    -1,
    1,
  ]);

  const vertexBuffer = device.createBuffer({
    label: "Cell vertices",
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  device.queue.writeBuffer(vertexBuffer, /*bufferOffset=*/ 0, vertices);

  const vertexBufferLayout: GPUVertexBufferLayout = {
    arrayStride: 8,
    attributes: [
      {
        format: "float32x2",
        offset: 0,
        shaderLocation: 0, // Position, see vertex shader
      },
    ],
  };

  // Create an array representing the active state of each cell.
  const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);

  // Create two storage buffers to hold the cell state.
  const cellStateStorage = [
    device.createBuffer({
      label: "Cell State A",
      size: cellStateArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    device.createBuffer({
      label: "Cell State B",
      size: cellStateArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
  ];

  for (let i = 0; i < cellStateArray.length; ++i) {
    cellStateArray[i] = Math.random() > 0.25 ? 1 : 0;
  }
  device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);

  const cellShaderModule = device.createShaderModule({
    label: "Cell shader",
    code: `
      struct VertexInput {
        @location(0) pos: vec2f,
        @builtin(instance_index) instance: u32,
      };
      
      struct VertexOutput {
        @builtin(position) pos: vec4f,
        @location(0) cell: vec2f, // New line!
      };
      
      @group(0) @binding(0) var<uniform> grid: vec2f;
      @group(0) @binding(1) var<storage> cellState: array<u32>; // New!
      
      @vertex
      fn vertexMain(@location(0) pos: vec2f,
                    @builtin(instance_index) instance: u32) -> VertexOutput {
        let i = f32(instance);
        let cell = vec2f(i % grid.x, floor(i / grid.x));
        let state = f32(cellState[instance]); // New line!
      
        let cellOffset = cell / grid * 2;
        // New: Scale the position by the cell's active state.
        let gridPos = (pos*state+1) / grid - 1 + cellOffset;
      
        var output: VertexOutput;
        output.pos = vec4f(gridPos, 0, 1);
        output.cell = cell;
        return output;
      }
        
      @fragment
      fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
        let c = input.cell / grid;
        return vec4f(c, 1-c.x, 1);
      }
    `,
  });

  const simulationShaderModule = device.createShaderModule({
    label: "Life simulation shader",
    code: `
      @group(0) @binding(0) var<uniform> grid: vec2f;
  
      @group(0) @binding(1) var<storage> cellStateIn: array<u32>;
      @group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;
  
      fn cellIndex(cell: vec2u) -> u32 {
        return (cell.y % u32(grid.y)) * u32(grid.x) +
                (cell.x % u32(grid.x));
      }
  
      fn cellActive(x: u32, y: u32) -> u32 {
        return cellStateIn[cellIndex(vec2(x, y))];
      }
  
      @compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
      fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
        // Determine how many active neighbors this cell has.
        let activeNeighbors = cellActive(cell.x+1, cell.y+1) +
                              cellActive(cell.x+1, cell.y) +
                              cellActive(cell.x+1, cell.y-1) +
                              cellActive(cell.x, cell.y-1) +
                              cellActive(cell.x-1, cell.y-1) +
                              cellActive(cell.x-1, cell.y) +
                              cellActive(cell.x-1, cell.y+1) +
                              cellActive(cell.x, cell.y+1);
  
        let i = cellIndex(cell.xy);
  
        // Conway's game of life rules:
        switch activeNeighbors {
          case 2: {
            cellStateOut[i] = cellStateIn[i];
          }
          case 3: {
            cellStateOut[i] = 1;
          }
          default: {
            cellStateOut[i] = 0;
          }
        }
      }
    `,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "Cell Bind Group Layout",
    entries: [
      {
        binding: 0,
        visibility:
          GPUShaderStage.VERTEX |
          GPUShaderStage.COMPUTE |
          GPUShaderStage.FRAGMENT,
        buffer: {}, // Grid uniform buffer
      },
      {
        binding: 1,
        visibility:
          GPUShaderStage.VERTEX |
          GPUShaderStage.COMPUTE |
          GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" }, // Cell state input buffer
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }, // Cell state output buffer
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "Cell Pipeline Layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const cellPipeline = device.createRenderPipeline({
    label: "Cell pipeline",
    layout: pipelineLayout,
    vertex: {
      module: cellShaderModule,
      entryPoint: "vertexMain",
      buffers: [vertexBufferLayout],
    },
    fragment: {
      module: cellShaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: canvasFormat,
        },
      ],
    },
  });

  // Create a compute pipeline that updates the game state.
  const simulationPipeline = device.createComputePipeline({
    label: "Simulation pipeline",
    layout: pipelineLayout,
    compute: {
      module: simulationShaderModule,
      entryPoint: "computeMain",
    },
  });

  const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
  const uniformBuffer = device.createBuffer({
    label: "Grid Uniforms",
    size: uniformArray.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

  const bindGroups = [
    device.createBindGroup({
      label: "Cell renderer bind group A",
      layout: bindGroupLayout, // Updated Line
      entries: [
        {
          binding: 0,
          resource: { buffer: uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: cellStateStorage[0] },
        },
        {
          binding: 2, // New Entry
          resource: { buffer: cellStateStorage[1] },
        },
      ],
    }),
    device.createBindGroup({
      label: "Cell renderer bind group B",
      layout: bindGroupLayout, // Updated Line

      entries: [
        {
          binding: 0,
          resource: { buffer: uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: cellStateStorage[1] },
        },
        {
          binding: 2, // New Entry
          resource: { buffer: cellStateStorage[0] },
        },
      ],
    }),
  ];

  function updateGrid() {
    if (!context) {
      throw new Error("Canvas context not initialized.");
    }

    stepDisplay.innerHTML = step.toString();

    // Start a render pass
    const encoder = device.createCommandEncoder();
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(simulationPipeline);
    computePass.setBindGroup(0, bindGroups[step % 2]);

    const workgroupCount = Math.ceil(GRID_SIZE / WORKGROUP_SIZE);
    computePass.dispatchWorkgroups(workgroupCount, workgroupCount);

    computePass.end();

    step++; // Increment the step count

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0.4, a: 1.0 },
          storeOp: "store",
        },
      ],
    });

    // Draw the grid.
    pass.setPipeline(cellPipeline);
    pass.setBindGroup(0, bindGroups[step % 2]); // Updated!
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE);

    // End the render pass and submit the command buffer
    pass.end();
    device.queue.submit([encoder.finish()]);

    requestAnimationFrame(updateGrid);
  }

  requestAnimationFrame(updateGrid);
}
