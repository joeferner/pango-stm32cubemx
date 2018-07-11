const stm32CubeMx = require('.');

module.exports = {
    targets: {
        'stm32cubemx': new stm32CubeMx.Stm32CubeMxTarget()
    }
};
