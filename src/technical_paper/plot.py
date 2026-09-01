import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

plt.rcParams["font.sans-serif"] = ["SimHei", "Microsoft YaHei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False


def plot_speed_surface():
    # ==================== 可调参数 ====================
    # 颜色+亮度 的总信息量（比特）
    # 当前设定：8级亮度 × 8种颜色 = 64种状态 -> log2(64) = 6 比特
    bits_color = 6  

    # 画面分辨率（单边像素数）
    resolution = 512  
    total_pixels = resolution ** 2  # 总像素数
    # =================================================

    # 1. 定义变量范围
    a_vals = np.arange(1, 21, 1)       # 码元宽度 a：从 1x1 到 20x20
    fps_vals = np.arange(10, 65, 5)    # 帧率：10fps 到 60fps

    # 2. 生成网格数据
    A, F = np.meshgrid(a_vals, fps_vals)

    # 3. 核心速度公式（精确版，包含全空形状）
    # 单码元总比特 = a^2 (形状) + bits_color (颜色亮度)
    # 码元总数 = total_pixels / a^2
    # 速度(Mbps) = (total_pixels / a^2) * (a^2 + bits_color) * F / 1_000_000
    speed_mbps = (total_pixels / (A ** 2)) * (A ** 2 + bits_color) * F / 1_000_000

    # ==================================================
    # 图1：三维曲面图（全景视角）
    # ==================================================
    fig = plt.figure(figsize=(14, 6))

    ax1 = fig.add_subplot(121, projection='3d')
    surf = ax1.plot_surface(A, F, speed_mbps, cmap='plasma', edgecolor='none', alpha=0.95)

    ax1.set_xlabel('码元宽度 a (像素)', fontsize=11)
    ax1.set_ylabel('帧率 (FPS)', fontsize=11)
    ax1.set_zlabel('理论速度 (Mbps)', fontsize=11)
    ax1.set_title(f'三维速度曲面图 (分辨率 {resolution}x{resolution})\n颜色+亮度 = {bits_color} 比特', fontsize=12)

    # 调整视角，方便看清 a 较小时的急速下降
    ax1.view_init(elev=25, azim=-60)

    cbar = fig.colorbar(surf, ax=ax1, shrink=0.6, aspect=15)
    cbar.set_label('速度 (Mbps)', fontsize=11)

    # ==================================================
    # 图2：二维切片对比图（30fps 和 60fps 下的速度曲线）
    # ==================================================
    ax2 = fig.add_subplot(122)

    # 选取 30fps 和 60fps 两条线
    speed_30fps = (total_pixels / (a_vals ** 2)) * (a_vals ** 2 + bits_color) * 30 / 1_000_000
    speed_60fps = (total_pixels / (a_vals ** 2)) * (a_vals ** 2 + bits_color) * 60 / 1_000_000

    # 计算渐近线（当 a 趋近无穷大时，速度 = total_pixels * FPS / 1e6）
    limit_30 = total_pixels * 30 / 1_000_000
    limit_60 = total_pixels * 60 / 1_000_000

    ax2.plot(a_vals, speed_30fps, 'o-', color='royalblue', linewidth=2, label='30 FPS 速度曲线')
    ax2.plot(a_vals, speed_60fps, 's-', color='crimson', linewidth=2, label='60 FPS 速度曲线')

    # 绘制渐近线（虚线）
    ax2.axhline(y=limit_30, color='royalblue', linestyle='--', alpha=0.6, label=f'30FPS 理论极限 ≈ {limit_30:.2f} Mbps')
    ax2.axhline(y=limit_60, color='crimson', linestyle='--', alpha=0.6, label=f'60FPS 理论极限 ≈ {limit_60:.2f} Mbps')

    # 标记推荐甜蜜点 (a=8)
    ax2.axvline(x=8, color='green', linestyle=':', linewidth=1.5, alpha=0.8, label='推荐甜蜜点 a=8')

    ax2.set_xlabel('码元宽度 a (像素)', fontsize=12)
    ax2.set_ylabel('理论速度 (Mbps)', fontsize=12)
    ax2.set_title('速度随 a 变化的收敛曲线', fontsize=12)
    ax2.grid(True, alpha=0.3)
    ax2.legend(loc='upper right')
    ax2.set_xlim(0, 20)

    plt.tight_layout()
    plt.show()

    # ==================================================
    # 控制台输出：关键参数速查（方便直接看数值）
    # ==================================================
    print("\n========== 关键参数速查 (基于新边界) ==========")
    print(f"画面分辨率: {resolution}x{resolution}, 颜色亮度比特: {bits_color} bits")
    print("-" * 50)
    for a in [1, 2, 4, 8, 12, 16]:
        speed_60 = (total_pixels / (a ** 2)) * (a ** 2 + bits_color) * 60 / 1_000_000
        speed_30 = (total_pixels / (a ** 2)) * (a ** 2 + bits_color) * 30 / 1_000_000
        print(f"a = {a:2d}  |  60fps: {speed_60:.2f} Mbps  |  30fps: {speed_30:.2f} Mbps")
    print("-" * 50)
    print(f"当 a→∞ 时，60fps 理论极限 = {total_pixels * 60 / 1_000_000:.2f} Mbps")
    print(f"当 a→∞ 时，30fps 理论极限 = {total_pixels * 30 / 1_000_000:.2f} Mbps")