// Canvas setup
const canvas = document.getElementById('flameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// State
let flameCount = 10;
let flames = [];
let tracesGenerated = 0;
let logsGenerated = 0;
let lastFrameTime = Date.now();
let frameCount = 0;
let fps = 60;

// Flame particle class
class Flame {
    constructor(x, y) {
        this.baseX = x;
        this.baseY = y;
        this.particles = [];
        this.createParticles();
    }

    createParticles() {
        const particleCount = 20;
        for (let i = 0; i < particleCount; i++) {
            this.particles.push({
                x: this.baseX,
                y: this.baseY,
                vx: (Math.random() - 0.5) * 2,
                vy: -Math.random() * 3 - 2,
                life: 1,
                size: Math.random() * 8 + 2,
                hue: Math.random() * 60 + 0, // Red to yellow
            });
        }
    }

    update() {
        this.particles.forEach((p, index) => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy -= 0.05; // Gravity upward
            p.life -= 0.01;
            p.size *= 0.97;

            // Remove dead particles
            if (p.life <= 0) {
                this.particles.splice(index, 1);
            }
        });

        // Add new particles
        if (this.particles.length < 20) {
            this.createParticles();
        }
    }

    draw(ctx) {
        this.particles.forEach(p => {
            ctx.save();
            ctx.globalAlpha = p.life;

            // Create gradient
            const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
            gradient.addColorStop(0, `hsla(${p.hue}, 100%, 70%, 1)`);
            gradient.addColorStop(0.5, `hsla(${p.hue + 20}, 100%, 60%, 0.6)`);
            gradient.addColorStop(1, `hsla(${p.hue + 40}, 100%, 50%, 0)`);

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    }
}

// Initialize flames
function initFlames() {
    flames = [];
    const spacing = canvas.width / (flameCount + 1);
    for (let i = 0; i < flameCount; i++) {
        const x = spacing * (i + 1);
        const y = canvas.height * 0.7 + (Math.random() - 0.5) * 100;
        flames.push(new Flame(x, y));
    }

    // Send trace data for flame initialization
    sendTraceData();
}

// Animation loop
function animate() {
    const now = Date.now();
    const elapsed = now - lastFrameTime;

    // Calculate FPS
    frameCount++;
    if (frameCount % 30 === 0) {
        fps = Math.round(1000 / elapsed);
        document.getElementById('fpsCounter').textContent = fps;
    }

    // Clear canvas
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Update and draw flames
    const renderStart = performance.now();
    flames.forEach(flame => {
        flame.update();
        flame.draw(ctx);
    });
    const renderDuration = performance.now() - renderStart;

    // Send render metrics every 60 frames
    if (frameCount % 60 === 0) {
        sendRenderMetrics(renderDuration);
    }

    // Generate logs periodically based on flame count
    if (frameCount % (120 - Math.min(flameCount * 2, 100)) === 0) {
        generateLogs();
    }

    lastFrameTime = now;
    requestAnimationFrame(animate);
}

// API calls to generate observability data
async function sendFlameUpdate(action) {
    try {
        const response = await fetch('/api/flames', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: flameCount, action })
        });
        if (response.ok) {
            tracesGenerated++;
            updateStats();
        }
    } catch (error) {
        console.error('Failed to send flame update:', error);
    }
}

async function sendRenderMetrics(duration) {
    try {
        const response = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration, flameCount })
        });
        if (response.ok) {
            const data = await response.json();
            logsGenerated += Math.ceil(flameCount / 5);
            updateStats();
        }
    } catch (error) {
        console.error('Failed to send render metrics:', error);
    }
}

async function generateLogs() {
    try {
        const response = await fetch('/api/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flameCount })
        });
        if (response.ok) {
            const data = await response.json();
            logsGenerated += data.logsGenerated || 0;
            updateStats();
        }
    } catch (error) {
        console.error('Failed to generate logs:', error);
    }
}

function sendTraceData() {
    tracesGenerated += flameCount;
    updateStats();
}

function updateStats() {
    document.getElementById('tracesCount').textContent = tracesGenerated.toLocaleString();
    document.getElementById('logsCount').textContent = logsGenerated.toLocaleString();
}

// Button handlers
document.getElementById('increaseBtn').addEventListener('click', () => {
    if (flameCount < 500) {
        flameCount += 5;
        document.getElementById('flameCount').textContent = flameCount;
        initFlames();
        sendFlameUpdate('increase');
    }
});

document.getElementById('decreaseBtn').addEventListener('click', () => {
    if (flameCount > 5) {
        flameCount -= 5;
        document.getElementById('flameCount').textContent = flameCount;
        initFlames();
        sendFlameUpdate('decrease');
    }
});

// Handle window resize
window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    initFlames();
});

// Keyboard controls
document.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') {
        document.getElementById('increaseBtn').click();
    } else if (e.key === '-' || e.key === '_') {
        document.getElementById('decreaseBtn').click();
    }
});

// Initialize
initFlames();
animate();
updateStats();

// Initial data send
setTimeout(() => {
    sendFlameUpdate('initial');
}, 1000);
