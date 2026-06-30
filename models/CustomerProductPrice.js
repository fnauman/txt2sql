/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// CustomerProductPrice: optional synthetic customer-specific product pricing.
	const CustomerProductPrice = sequelize.define('CustomerProductPrice', {
		CustomerProductPriceId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the customer product price row.'
		},
		CustomerId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			references: { model: 'Customer', key: 'CustomerId' },
			comment: 'Customer receiving this product price.'
		},
		ProductId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			references: { model: 'Product', key: 'ProductId' },
			comment: 'Product covered by this customer-specific price.'
		},
		SalePrice: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			comment: 'Synthetic customer-specific sale price.'
		},
		EffectiveDate: {
			type: DataTypes.DATEONLY,
			allowNull: true,
			comment: 'Date when the price becomes effective.'
		}
	}, {
		tableName: 'CustomerProductPrice',
		timestamps: false,
		freezeTableName: true
	});

	CustomerProductPrice.associate = (models) => {
		CustomerProductPrice.belongsTo(models.Customer, { foreignKey: 'CustomerId', as: 'Customer' });
		CustomerProductPrice.belongsTo(models.Product, { foreignKey: 'ProductId', as: 'Product' });
	};

	return CustomerProductPrice;
};
