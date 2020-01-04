const stm32CubeMx = require('.');

module.exports = {
    targets: {
        'stm32cubemx-init': new stm32CubeMx.Stm32CubeMxInitTarget(),
        'stm32cubemx': new stm32CubeMx.Stm32CubeMxTarget()
    }
};
